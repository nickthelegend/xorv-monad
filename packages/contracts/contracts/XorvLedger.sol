// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IIdentityRegistry8004} from "./interfaces/IIdentityRegistry8004.sol";
import {IReputationRegistry8004} from "./interfaces/IReputationRegistry8004.sol";

/// @title XorvLedger
/// @notice The public record of the Xorv network on Monad: provider registrations and heartbeats,
///         one receipt per x402-paid job, and a relay that turns a buyer's rating of a job they
///         actually paid for into ERC-8004 reputation feedback.
///
/// @dev    Why a contract at all, when x402 already settles on-chain: the USDC transfer proves that
///         money moved, not what it bought. A receipt binds the settlement tx to the job (request
///         and result hashes, duration, outcome) and to the provider's ERC-8004 identity, and it is
///         the gate for ratings: exactly one per recorded job, and only with the payer's consent.
///
///         Every rating reaches the Reputation Registry with clientAddress == address(this). Reading
///         getSummary(agentId, [ledger], "starred", "") therefore gives a "paid and delivered" score
///         that a Sybil cannot inflate without paying for each fake job. For the same reason this
///         contract must never own or operate a provider's agent NFT: ERC-8004 rejects feedback from
///         an agent's owner or operators, so doing so would brick rating for that agent.
///
///         Gas on Monad shapes the whole layout:
///         - Monad bills the transaction's gas LIMIT, not the gas used (execution is asynchronous,
///           so the block is built before anything runs). The broker sizes every call from
///           eth_estimateGas plus a small margin; a padded constant is money thrown away.
///         - The 21k intrinsic cost, the cold access to this contract and the cold access to the
///           Identity Registry (10,100 on Monad vs 2,600 on Ethereum) are paid once per
///           transaction, so receipts are written in batches (recordJobs) rather than one per job.
///         - A net-new storage slot costs ~27.9k on Monad (8,000 page load + 2,800 page write +
///           17,000 state growth + 100 base), while log bytes are cheap and nobody needs them in
///           state. So each job gets ONE packed slot, holding exactly what rateJob must verify, and
///           everything else (amounts, hashes, provider labels, heartbeats) lives only in events,
///           which the indexer reads. Registrations and heartbeats write no storage at all.
contract XorvLedger is EIP712("XorvLedger", "1") {
    /// @notice agentId for a provider that has no ERC-8004 identity. Its jobs are still recorded,
    ///         but they can't be rated, because there is no agent to attach reputation to.
    uint256 public constant NO_AGENT = type(uint256).max;

    /// @dev JobState.agentId value meaning "no agent". Real agentIds are sequential from 0 (about
    ///      10k on Monad mainnet today), so 2^64 - 1 is unreachable in practice.
    uint64 private constant NO_AGENT_ID = type(uint64).max;

    /// @notice One settled job, as the broker saw it. Hashes are keccak256 of the UTF-8 text so the
    ///         raw prompt and result never leave the broker, but anyone holding them can check.
    struct JobReceipt {
        bytes32 jobId; //        keccak256(utf8(brokerJobId))
        uint256 agentId; //      provider's ERC-8004 agentId, or NO_AGENT
        address buyer; //        x402 payer (the EIP-3009 `from`); the only address that may rate
        address payTo; //        x402 payTo; must be the agent's verified wallet when agentId is set
        uint256 amount; //       USDC base units (6 decimals)
        bytes32 paymentTx; //    x402 settlement tx hash on Monad (zero if the job was not paid)
        bytes32 requestHash; //  keccak256(utf8(prompt))
        bytes32 resultHash; //   keccak256(utf8(result ?? ""))
        uint32 durationMs; //    wall-clock run time on the provider
        bool ok; //              job finished successfully
    }

    /// @notice A buyer's rating of one job. Signed as EIP-712 typed data when a relayer submits it.
    struct Rating {
        bytes32 jobId;
        int128 value; //         0..100, valueDecimals 0: the ERC-8004 "starred" convention
        string tag2; //          adapter, e.g. "claude-code". Stored by the registry: keep < 32 bytes
        string endpoint; //      emitted by the registry only
        string feedbackURI; //   off-chain feedback file (ERC-8004 feedback schema), emitted only
        bytes32 feedbackHash; // keccak256 of the feedback file bytes
        uint256 deadline; //     unix seconds; only enforced for relayed (signed) ratings
    }

    /// @notice Everything rateJob needs, in one 32-byte slot: 20 + 8 + 1 bytes.
    ///         buyer == address(0) means "no such job", which is why recordJobs rejects a zero buyer.
    struct JobState {
        address buyer;
        uint64 agentId; // NO_AGENT_ID when the provider had no ERC-8004 identity
        bool rated;
    }

    bytes32 public constant RATING_TYPEHASH = keccak256(
        "Rating(bytes32 jobId,int128 value,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash,uint256 deadline)"
    );

    IIdentityRegistry8004 public immutable identity;
    IReputationRegistry8004 public immutable reputation;

    /// @notice Can rotate the broker and hand over ownership. Nothing else.
    address public owner;
    /// @notice The broker's hot EOA: the only writer of registrations, heartbeats and receipts.
    address public broker;

    mapping(bytes32 jobId => JobState) public jobs;

    event ProviderRegistered(
        bytes32 indexed providerId, address indexed payTo, uint256 indexed agentId, string label, string capabilities
    );
    event ProviderHeartbeat(bytes32 indexed providerId, uint32 activeJobs, uint32 capacity, uint32 uptimeSeconds);
    event JobRecorded(
        bytes32 indexed jobId,
        uint256 indexed agentId,
        address indexed buyer,
        address payTo,
        uint256 amount,
        bytes32 paymentTx,
        bytes32 requestHash,
        bytes32 resultHash,
        uint32 durationMs,
        bool ok
    );
    event JobRated(bytes32 indexed jobId, uint256 indexed agentId, address indexed buyer, int128 value, bytes32 feedbackHash);
    event BrokerSet(address indexed broker);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotBroker();
    error DuplicateJob(bytes32 jobId);
    error UnknownJob(bytes32 jobId);
    error AlreadyRated(bytes32 jobId);
    error NoAgent(bytes32 jobId);
    error PayToNotAgentWallet(uint256 agentId, address payTo, address agentWallet);
    error BadValue();
    error Expired();
    error BadSignature();
    error AgentIdTooLarge();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyBroker() {
        if (msg.sender != broker) revert NotBroker();
        _;
    }

    /// @param identity_   ERC-8004 Identity Registry on this chain.
    /// @param reputation_ ERC-8004 Reputation Registry on this chain.
    /// @param broker_     The broker EOA allowed to write. The deployer becomes the owner.
    constructor(address identity_, address reputation_, address broker_) {
        if (identity_ == address(0) || reputation_ == address(0) || broker_ == address(0)) revert ZeroAddress();
        identity = IIdentityRegistry8004(identity_);
        reputation = IReputationRegistry8004(reputation_);
        owner = msg.sender;
        broker = broker_;
        // Emitted so an indexer starting at the deploy block learns both roles from events alone.
        emit OwnershipTransferred(address(0), msg.sender);
        emit BrokerSet(broker_);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @notice Rotate the broker key (e.g. after a leak). Zero is refused: an unset writer would
    ///         look like a pause but silently drop every receipt the broker tries to publish.
    function setBroker(address broker_) external onlyOwner {
        if (broker_ == address(0)) revert ZeroAddress();
        broker = broker_;
        emit BrokerSet(broker_);
    }

    /// @notice Single-step handover. Renouncing (zero) is refused, since it would freeze the broker
    ///         key forever and a leaked broker key could then never be rotated out.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ---------------------------------------------------------------------------------------------
    // Broker writes
    // ---------------------------------------------------------------------------------------------

    /// @notice Announce a provider node. Event only: the broker keeps liveness in memory and the
    ///         indexer builds the provider table, so paying for state here would buy nothing.
    /// @dev    With an agentId, payTo must be the agent's verified ERC-8004 wallet. That is what lets
    ///         a buyer trust that "agent #N" really is who gets paid, and it is the same check every
    ///         receipt for this provider will face in recordJobs.
    /// @param capabilities compact "adapter:priceUsdMicros" list, e.g. "claude-code:10000,qwen:5000".
    function registerProvider(
        bytes32 providerId,
        address payTo,
        uint256 agentId,
        string calldata label,
        string calldata capabilities
    ) external onlyBroker {
        if (payTo == address(0)) revert ZeroAddress();
        if (agentId != NO_AGENT) _checkAgentWallet(agentId, payTo);
        emit ProviderRegistered(providerId, payTo, agentId, label, capabilities);
    }

    /// @notice Periodic liveness/capacity sample (the broker publishes every Nth heartbeat, not all).
    function heartbeat(bytes32 providerId, uint32 activeJobs, uint32 capacity, uint32 uptimeSeconds)
        external
        onlyBroker
    {
        emit ProviderHeartbeat(providerId, activeJobs, capacity, uptimeSeconds);
    }

    /// @notice Record a batch of settled jobs: one packed slot + one event each.
    /// @dev    Batching is the point: on Monad the fixed per-tx costs (21k intrinsic, cold accounts at
    ///         10,100) dwarf the marginal cost of a receipt, and the broker pays for the gas limit it
    ///         asks for, so it estimates the exact batch and adds a small margin.
    ///
    ///         The whole batch reverts on the first bad receipt (duplicate, zero buyer, payTo that is
    ///         not the agent's wallet). A partial write would leave the broker unable to tell which
    ///         receipts landed; all-or-nothing keeps its retry logic trivial, at the price of having
    ///         to validate receipts before submitting them.
    function recordJobs(JobReceipt[] calldata receipts) external onlyBroker {
        // The same provider usually appears several times in one batch. getAgentWallet cannot change
        // within this transaction (nothing here writes to the registry; the lookup is a staticcall),
        // so when a receipt repeats the (agentId, payTo) pair checked just before it, the external
        // call is skipped. Grouping a batch by provider makes every repeat a hit.
        uint256 checkedAgentId = NO_AGENT;
        address checkedPayTo;

        uint256 n = receipts.length;
        for (uint256 i; i < n;) {
            JobReceipt calldata r = receipts[i];
            bytes32 jobId = r.jobId;
            address buyer = r.buyer;
            uint256 agentId = r.agentId;
            address payTo = r.payTo;

            // A zero buyer would be stored as "no such job": undetectable duplicates, unratable job.
            // A zero payTo is never a real provider (see _checkAgentWallet for why it matters there).
            if (buyer == address(0) || payTo == address(0)) revert ZeroAddress();
            // An existing job always has a non-zero buyer (enforced just above).
            if (jobs[jobId].buyer != address(0)) revert DuplicateJob(jobId);

            uint64 storedAgentId;
            if (agentId == NO_AGENT) {
                storedAgentId = NO_AGENT_ID;
            } else {
                if (agentId != checkedAgentId || payTo != checkedPayTo) {
                    _checkAgentWallet(agentId, payTo);
                    checkedAgentId = agentId;
                    checkedPayTo = payTo;
                }
                storedAgentId = uint64(agentId); // _checkAgentWallet bounded it below NO_AGENT_ID
            }

            jobs[jobId] = JobState({buyer: buyer, agentId: storedAgentId, rated: false});
            _emitJobRecorded(r);

            unchecked {
                ++i;
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Ratings
    // ---------------------------------------------------------------------------------------------

    /// @notice Rate a recorded job and forward the rating to the ERC-8004 Reputation Registry as
    ///         giveFeedback(agentId, value, 0, "starred", tag2, endpoint, feedbackURI, feedbackHash).
    /// @dev    Two ways in:
    ///         - the buyer calls directly and pays the gas; `buyerSig` is ignored (pass empty bytes);
    ///         - anyone relays (in practice the broker, so rating is gasless for the buyer) with the
    ///           buyer's EIP-712 signature over the Rating. SignatureChecker accepts an ECDSA signature
    ///           from an EOA (or EIP-7702 account) and falls back to ERC-1271 for smart accounts, which
    ///           covers passkey wallets backed by Monad's P256 precompile.
    ///         The deadline bounds how long a signed rating can sit in a relayer's queue. It is not
    ///         checked on the direct path, where there is no signature to expire.
    ///
    ///         One rating per job, for jobs whose provider has an agentId. Replays are impossible:
    ///         the digest binds chainId, this contract and the jobId, and `rated` is set before the
    ///         external call.
    function rateJob(Rating calldata r, bytes calldata buyerSig) external {
        bytes32 jobId = r.jobId;
        JobState storage s = jobs[jobId];
        address buyer = s.buyer; // buyer, agentId and rated share one slot: only this read is cold
        uint64 agentId = s.agentId;

        if (buyer == address(0)) revert UnknownJob(jobId);
        if (s.rated) revert AlreadyRated(jobId);
        if (agentId == NO_AGENT_ID) revert NoAgent(jobId);
        if (r.value < 0 || r.value > 100) revert BadValue();

        if (msg.sender != buyer) {
            if (block.timestamp > r.deadline) revert Expired();
            if (!SignatureChecker.isValidSignatureNow(buyer, ratingDigest(r), buyerSig)) revert BadSignature();
        }

        // Effects before the interaction: the registry is trusted, but the write costs the same
        // either way, and it makes re-entering rateJob for this job impossible.
        s.rated = true;

        _giveFeedback(agentId, r);

        emit JobRated(jobId, agentId, buyer, r.value, r.feedbackHash);
    }

    /// @notice The EIP-712 digest a buyer signs for `r`, under the domain
    ///         {name: "XorvLedger", version: "1", chainId, verifyingContract: this}.
    ///         Exposed so the broker and the app can check a signature before paying to relay it.
    function ratingDigest(Rating calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RATING_TYPEHASH,
                    r.jobId,
                    r.value,
                    keccak256(bytes(r.tag2)),
                    keccak256(bytes(r.endpoint)),
                    keccak256(bytes(r.feedbackURI)),
                    r.feedbackHash,
                    r.deadline
                )
            )
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev For a provider with an agentId, payTo must be that agent's verified ERC-8004 wallet.
    ///      Callers reject payTo == address(0) first, and that matters beyond hygiene: getAgentWallet
    ///      returns address(0) both for an agent whose wallet was cleared by an NFT transfer and for
    ///      an agentId that was never minted, and a zero payTo would otherwise "match" either.
    function _checkAgentWallet(uint256 agentId, address payTo) private view {
        // agentId has to fit JobState's uint64 with NO_AGENT_ID still free as the sentinel.
        if (agentId >= NO_AGENT_ID) revert AgentIdTooLarge();
        address wallet = identity.getAgentWallet(agentId);
        if (wallet != payTo) revert PayToNotAgentWallet(agentId, payTo, wallet);
    }

    /// @dev The registry sees msg.sender == address(this), so every rating lands under the ledger's
    ///      clientAddress. Nearly all of rateJob's gas is spent in here: the registry stores value,
    ///      decimals and both tags, plus the agent's client list on the ledger's first rating of it.
    ///      A separate frame also keeps the eight-argument call clear of rateJob's locals.
    function _giveFeedback(uint256 agentId, Rating calldata r) private {
        reputation.giveFeedback(agentId, r.value, 0, "starred", r.tag2, r.endpoint, r.feedbackURI, r.feedbackHash);
    }

    /// @dev Split out of the loop so the ten event fields don't share a stack frame with it.
    function _emitJobRecorded(JobReceipt calldata r) private {
        emit JobRecorded(
            r.jobId, r.agentId, r.buyer, r.payTo, r.amount, r.paymentTx, r.requestHash, r.resultHash, r.durationMs, r.ok
        );
    }
}
