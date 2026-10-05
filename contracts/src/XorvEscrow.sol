// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IXorvRegistry} from "./interfaces/IXorvRegistry.sol";

/**
 * @title XorvEscrow
 * @notice Holds the payment for one AI job between "the buyer signed" and
 *         "the provider delivered", so neither side has to trust the other or
 *         the broker in between.
 *
 * ## Why escrow at all
 *
 * The first versions of Xorv paid the provider directly at the moment of
 * purchase. That is simple and it is backwards: the buyer takes all the risk.
 * If the provider's machine dies mid-job, the money has already moved and the
 * only remedy is an off-chain promise. Here the money waits, and there are
 * exactly three ways out of a funded job:
 *
 *   1. `release`  — the job delivered. The provider is paid, and the hash of
 *                   the result is recorded next to the payment.
 *   2. `refund`   — the job failed (attester, at any time) or nobody settled
 *                   it before the deadline (anyone, after it). The buyer gets
 *                   every unit back.
 *   3. `reassign` — the provider failed but another can take the job. The
 *                   money stays put; only the payee changes.
 *
 * ## The buyer never needs gas, and their signature can't be misused
 *
 * Funding uses EIP-3009 `receiveWithAuthorization`. The buyer signs typed data
 * off-chain; the broker's attester submits it. Two properties make that safe:
 *
 * - `receiveWithAuthorization` requires `msg.sender == to`. The payee is this
 *   contract, so the authorization can only be redeemed *through* `fund` —
 *   it cannot be front-run into a bare transfer that lands money without a job.
 * - The authorization's nonce is not random: it is `fundingNonce(jobId,
 *   deadline)`, derived from the job's identity, this chain and this contract.
 *   The buyer's one signature therefore commits to the amount, the token, the
 *   payee, the job and its refund deadline. A relayer that changes any of them
 *   produces a nonce the signature does not cover, and the token rejects it.
 *
 * ## What the owner can and cannot do
 *
 * The owner configures (tokens, attester, fee, registry, pause). The owner can
 * never move escrowed funds: there is no admin withdrawal, `sweep` only reaches
 * tokens sent here by mistake (balance above what jobs hold), fees are capped
 * at `MAX_FEE_BPS` and snapshotted per job at funding, and `pause` stops new
 * jobs without ever blocking a release or a refund.
 *
 * ## Reputation is a side effect of settlement
 *
 * Every release, attester refund and reassignment reports an outcome to the
 * provider registry (XorvRegistry). A registry
 * that reverts or runs out of gas is caught and logged; it can never hold a
 * payment hostage.
 */
contract XorvEscrow is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Status {
        None,
        Funded,
        Released,
        Refunded
    }

    /**
     * One job's escrow record, packed into three slots.
     *
     * slot 0: buyer (20) | deadline (5) | status (1) | feeBps (2)
     * slot 1: provider (20) | amount (12)
     * slot 2: token (20)
     */
    struct Job {
        address buyer;
        uint40 deadline;
        Status status;
        uint16 feeBps;
        address provider;
        uint96 amount;
        address token;
    }

    /// Everything `fund` needs, grouped to keep the call site readable and the stack shallow.
    struct Funding {
        bytes32 jobId;
        address buyer;
        address provider;
        address token;
        uint256 amount;
        uint40 deadline;
        uint256 validAfter;
        uint256 validBefore;
        bytes signature;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// Hard ceiling on the protocol fee: 5%. The live fee is 0.
    uint16 public constant MAX_FEE_BPS = 500;

    uint16 private constant BPS = 10_000;

    /// A job must leave the provider at least this long to deliver.
    uint40 public constant MIN_JOB_DURATION = 1 minutes;

    /// And may not park a buyer's money for longer than this.
    uint40 public constant MAX_JOB_DURATION = 7 days;

    /// Gas forwarded to the registry. Enough for the registry's worst-case (first-outcome) write with room to spare.
    uint256 public constant REGISTRY_GAS_LIMIT = 150_000;

    /// Gas that must remain before the registry call so it receives its whole budget:
    /// the budget, the 1/64 EIP-150 withholds from it, and room for the CALL itself.
    uint256 public constant REGISTRY_GAS_RESERVE = REGISTRY_GAS_LIMIT + REGISTRY_GAS_LIMIT / 63 + 10_000;

    /// Domain tag for `fundingNonce`, so the nonce cannot collide with one minted elsewhere.
    bytes32 public constant FUNDING_NONCE_TYPEHASH =
        keccak256("XorvFunding(uint256 chainId,address escrow,bytes32 jobId,uint40 deadline)");

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(bytes32 jobId => Job) private _jobs;

    /// Stablecoins jobs can be funded in. Only EIP-3009 tokens without transfer fees belong here.
    mapping(address token => bool) public tokenAllowed;

    /// Sum of all funded-but-unsettled amounts per token. `sweep` can never touch this.
    mapping(address token => uint256) public totalEscrowed;

    /// The broker's settlement key: funds jobs, releases on delivery, refunds on failure.
    address public attester;

    /// Provider registry. Zero disables outcome reporting.
    IXorvRegistry public registry;

    /// Protocol fee applied to jobs funded from now on, and who receives it.
    uint16 public feeBps;
    address public feeRecipient;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event JobFunded(
        bytes32 indexed jobId,
        address indexed buyer,
        address indexed provider,
        address token,
        uint256 amount,
        uint40 deadline
    );
    event JobReleased(
        bytes32 indexed jobId,
        address indexed provider,
        uint256 providerAmount,
        uint256 fee,
        bytes32 resultHash,
        address releasedBy
    );
    event JobRefunded(
        bytes32 indexed jobId, address indexed buyer, uint256 amount, bool providerAtFault
    );
    event JobReassigned(
        bytes32 indexed jobId, address indexed previousProvider, address indexed newProvider
    );
    event RegistryCallFailed(bytes32 indexed jobId, address indexed provider, bytes reason);

    event AttesterUpdated(address indexed previous, address indexed attester);
    event RegistryUpdated(address indexed previous, address indexed registry);
    event TokenAllowed(address indexed token, bool allowed);
    event FeeUpdated(uint16 feeBps, address indexed recipient);
    event Swept(address indexed token, address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotAttester(address caller);
    error NotAuthorized(address caller);
    error ZeroAddress();
    error JobExists(bytes32 jobId);
    error JobNotFunded(bytes32 jobId, Status status);
    error TokenNotAllowed(address token);
    error InvalidAmount(uint256 amount);
    error InvalidParties(address buyer, address provider);
    error InvalidDeadline(uint40 deadline);
    error DeadlinePassed(bytes32 jobId, uint40 deadline);
    error DeadlineNotReached(bytes32 jobId, uint40 deadline);
    error AmountMismatch(uint256 expected, uint256 received);
    error FeeTooHigh(uint16 feeBps);
    error NothingToSweep(address token);
    error RenounceDisabled();
    error InsufficientGasForRegistry();

    // ---------------------------------------------------------------------
    // Construction and admin
    // ---------------------------------------------------------------------

    constructor(
        address initialOwner,
        address initialAttester,
        address initialRegistry,
        address[] memory tokens
    ) Ownable(initialOwner) {
        _setAttester(initialAttester);
        registry = IXorvRegistry(initialRegistry);
        emit RegistryUpdated(address(0), initialRegistry);
        for (uint256 i = 0; i < tokens.length; ++i) {
            _setTokenAllowed(tokens[i], true);
        }
    }

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester(msg.sender);
        _;
    }

    function setAttester(address newAttester) external onlyOwner {
        _setAttester(newAttester);
    }

    /// Zero disables outcome reporting; payments are unaffected either way.
    function setRegistry(address newRegistry) external onlyOwner {
        emit RegistryUpdated(address(registry), newRegistry);
        registry = IXorvRegistry(newRegistry);
    }

    /// Disallowing a token stops new jobs in it. Jobs already funded settle normally.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        _setTokenAllowed(token, allowed);
    }

    /// Applies to jobs funded after this call; funded jobs keep the fee they were funded under.
    function setFee(uint16 newFeeBps, address recipient) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps);
        if (newFeeBps != 0 && recipient == address(0)) revert ZeroAddress();
        feeBps = newFeeBps;
        feeRecipient = recipient;
        emit FeeUpdated(newFeeBps, recipient);
    }

    /// Stops new jobs from being funded. Never blocks a release or a refund.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * Recover tokens sent here by mistake: anything above what funded jobs hold.
     * @dev `totalEscrowed` is subtracted first, so buyers' money is unreachable.
     */
    function sweep(address token, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 excess = IERC20(token).balanceOf(address(this)) - totalEscrowed[token];
        if (excess == 0) revert NothingToSweep(token);
        IERC20(token).safeTransfer(to, excess);
        emit Swept(token, to, excess);
    }

    /// An escrow without an owner could never add a token or rotate a leaked attester key.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------
    // Job lifecycle
    // ---------------------------------------------------------------------

    /**
     * The EIP-3009 nonce a buyer must sign to fund `jobId` with this `deadline`.
     * @dev Binding the nonce to the job is what lets one signature commit to
     *      the job's identity and refund deadline, on top of the amount, token
     *      and payee that `ReceiveWithAuthorization` already covers.
     */
    function fundingNonce(bytes32 jobId, uint40 deadline) public view returns (bytes32) {
        return keccak256(
            abi.encode(FUNDING_NONCE_TYPEHASH, block.chainid, address(this), jobId, deadline)
        );
    }

    /**
     * Pull the buyer's payment into escrow for `f.jobId`.
     *
     * @dev The balance is measured on both sides of the pull, so a token that
     *      skims a transfer fee (none on the allowlist do) reverts instead of
     *      leaving the escrow short of what it owes.
     */
    function fund(Funding calldata f) external onlyAttester whenNotPaused nonReentrant {
        Job storage job = _jobs[f.jobId];
        if (job.status != Status.None) revert JobExists(f.jobId);
        if (!tokenAllowed[f.token]) revert TokenNotAllowed(f.token);
        if (f.amount == 0 || f.amount > type(uint96).max) revert InvalidAmount(f.amount);
        if (f.buyer == address(0) || f.provider == address(0) || f.buyer == f.provider) {
            revert InvalidParties(f.buyer, f.provider);
        }
        if (
            f.deadline < block.timestamp + MIN_JOB_DURATION
                || f.deadline > block.timestamp + MAX_JOB_DURATION
        ) revert InvalidDeadline(f.deadline);

        // Effects before the external call. If the pull fails the whole
        // transaction reverts, so there is no half-funded state to unwind.
        job.buyer = f.buyer;
        job.deadline = f.deadline;
        job.status = Status.Funded;
        job.feeBps = feeBps;
        job.provider = f.provider;
        job.amount = uint96(f.amount);
        job.token = f.token;
        totalEscrowed[f.token] += f.amount;

        uint256 before = IERC20(f.token).balanceOf(address(this));
        IERC3009(f.token).receiveWithAuthorization(
            f.buyer,
            address(this),
            f.amount,
            f.validAfter,
            f.validBefore,
            fundingNonce(f.jobId, f.deadline),
            f.signature
        );
        uint256 received = IERC20(f.token).balanceOf(address(this)) - before;
        if (received != f.amount) revert AmountMismatch(f.amount, received);

        emit JobFunded(f.jobId, f.buyer, f.provider, f.token, f.amount, f.deadline);
    }

    /**
     * Pay the provider for a delivered job.
     *
     * @param resultHash SHA-256 of the result the provider returned, so anyone
     *        holding the result can prove it is the one that was paid for,
     *        without the result ever being public.
     * @dev Callable by the attester until the deadline, or by the buyer at any
     *      time while funded (a buyer happy with the work can always pay).
     */
    function release(bytes32 jobId, bytes32 resultHash) external nonReentrant {
        Job storage job = _funded(jobId);
        if (msg.sender == attester) {
            if (block.timestamp > job.deadline) revert DeadlinePassed(jobId, job.deadline);
        } else if (msg.sender != job.buyer) {
            revert NotAuthorized(msg.sender);
        }

        address provider = job.provider;
        address token = job.token;
        uint256 amount = job.amount;
        uint256 fee = (amount * job.feeBps) / BPS;
        uint256 providerAmount = amount - fee;

        job.status = Status.Released;
        totalEscrowed[token] -= amount;

        IERC20(token).safeTransfer(provider, providerAmount);
        if (fee != 0) IERC20(token).safeTransfer(feeRecipient, fee);

        emit JobReleased(jobId, provider, providerAmount, fee, resultHash, msg.sender);
        _reportOutcome(jobId, provider, true, providerAmount);
    }

    /**
     * Return a job's full amount to its buyer.
     *
     * - The attester may refund at any time: the provider failed and no other
     *   could take the job. This counts against the provider's reputation.
     * - Anyone may refund once the deadline has passed. The money can only go
     *   to the buyer, so letting a keeper trigger it costs the buyer nothing.
     *   It does not count against the provider: an unsettled job may equally be
     *   the broker's fault.
     */
    function refund(bytes32 jobId) external nonReentrant {
        Job storage job = _funded(jobId);
        bool providerAtFault = msg.sender == attester;
        if (!providerAtFault && block.timestamp <= job.deadline) {
            revert DeadlineNotReached(jobId, job.deadline);
        }

        address buyer = job.buyer;
        address token = job.token;
        uint256 amount = job.amount;

        job.status = Status.Refunded;
        totalEscrowed[token] -= amount;

        IERC20(token).safeTransfer(buyer, amount);

        emit JobRefunded(jobId, buyer, amount, providerAtFault);
        if (providerAtFault) _reportOutcome(jobId, job.provider, false, 0);
    }

    /**
     * Return a job's full amount to its buyer because the *buyer* called it off.
     *
     * The same money movement as `refund`, without the mark: a buyer changing
     * their mind is not the provider failing, and reputation is permanent. It
     * is attester-only rather than open to the buyer on chain, because a buyer
     * who could cancel directly could void payment for work already delivered
     * in the moments before its release; the broker, which sees the job's
     * state, is the one that decides a cancel is still honest.
     */
    function cancel(bytes32 jobId) external onlyAttester nonReentrant {
        Job storage job = _funded(jobId);
        address buyer = job.buyer;
        address token = job.token;
        uint256 amount = job.amount;

        job.status = Status.Refunded;
        totalEscrowed[token] -= amount;

        IERC20(token).safeTransfer(buyer, amount);
        emit JobRefunded(jobId, buyer, amount, false);
    }

    /**
     * Hand a funded job to a different provider after the first one failed.
     * @dev The buyer's money never moves; only the eventual payee changes. The
     *      deadline is unchanged, so reassignment can never extend how long a
     *      buyer waits for a refund.
     */
    function reassign(bytes32 jobId, address newProvider) external onlyAttester nonReentrant {
        Job storage job = _funded(jobId);
        if (block.timestamp > job.deadline) revert DeadlinePassed(jobId, job.deadline);
        address previous = job.provider;
        if (newProvider == address(0) || newProvider == job.buyer || newProvider == previous) {
            revert InvalidParties(job.buyer, newProvider);
        }
        job.provider = newProvider;
        emit JobReassigned(jobId, previous, newProvider);
        _reportOutcome(jobId, previous, false, 0);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getJob(bytes32 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    /// True when `refund` would succeed for a caller that is not the attester.
    function isRefundable(bytes32 jobId) external view returns (bool) {
        Job storage job = _jobs[jobId];
        return job.status == Status.Funded && block.timestamp > job.deadline;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _funded(bytes32 jobId) private view returns (Job storage job) {
        job = _jobs[jobId];
        if (job.status != Status.Funded) revert JobNotFunded(jobId, job.status);
    }

    /**
     * Report an outcome to the registry without ever letting it block settlement.
     *
     * @dev The call gets a fixed gas budget and any failure is caught, so a
     *      broken registry can't hold a payment hostage.
     *
     *      That `try/catch` has a trap: the transaction succeeds whether or not
     *      the registry call does, so a caller — or simply a gas *estimator*,
     *      which searches for the smallest limit at which the transaction
     *      succeeds — can supply enough gas for the payment but too little for
     *      the registry. Under EIP-150 the callee then gets 63/64 of whatever
     *      is left, runs out, and the provider's reputation silently never
     *      moves. This was found on a live dev node, where `estimateGas`
     *      produced exactly that transaction every time.
     *
     *      So the full budget is required *before* the call: with less than
     *      `REGISTRY_GAS_RESERVE` remaining the whole transaction reverts, and
     *      an estimator is forced to include the registry's share.
     */
    function _reportOutcome(bytes32 jobId, address provider, bool success, uint256 amount) private {
        IXorvRegistry reg = registry;
        if (address(reg) == address(0)) return;
        if (gasleft() < REGISTRY_GAS_RESERVE) revert InsufficientGasForRegistry();
        try reg.recordOutcome{gas: REGISTRY_GAS_LIMIT}(provider, success, amount) {}
        catch (bytes memory reason) {
            emit RegistryCallFailed(jobId, provider, reason);
        }
    }

    function _setAttester(address newAttester) private {
        emit AttesterUpdated(attester, newAttester);
        attester = newAttester;
    }

    function _setTokenAllowed(address token, bool allowed) private {
        if (token == address(0)) revert ZeroAddress();
        tokenAllowed[token] = allowed;
        emit TokenAllowed(token, allowed);
    }
}
