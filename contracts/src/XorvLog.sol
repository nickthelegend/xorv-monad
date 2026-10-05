// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * XorvLog — the public audit trail for the Xorv network.
 *
 * On Hedera this was three Consensus Service topics: registrations, heartbeats,
 * receipts. Arc has no HCS, so the same guarantee is rebuilt from the one
 * primitive an EVM chain gives you for free — event logs, which are ordered,
 * append-only, attributed to their sender, and retrievable by anyone from any
 * RPC node without credentials.
 *
 * Three deliberate design choices, each inherited from what the topics did:
 *
 * 1. **Anyone can write.** The Hedera topics were created without a submit key,
 *    so any account could publish to them. That is not an oversight in either
 *    design: a marketplace audit log that only the marketplace can write to
 *    proves nothing. Attribution is what makes it useful, and `msg.sender` on
 *    the event does the job `payer_account_id` did on the mirror node. A reader
 *    filters to the authors it trusts; the chain does not decide for them.
 *
 * 2. **Nothing is stored.** Every entry lives in the log, not in state. Events
 *    cannot be read back by a contract, which is exactly right — nothing on
 *    chain consumes this, only humans and indexers do — and it makes an entry
 *    cost a fraction of what an SSTORE would. On a chain where gas is settled
 *    in USDC, that difference is the difference between logging every heartbeat
 *    and logging none of them.
 *
 * 3. **The payload stays small.** HCS charged the same for any message up to
 *    1024 bytes and chunked beyond it; here calldata is billed per byte. The
 *    cap is kept at 1024 for parity, and because it enforces the property that
 *    matters: a receipt carries a *hash* of a job's result, never the result
 *    itself. The record is publicly verifiable without the work ever being
 *    public.
 */
contract XorvLog {
    /// Registration of a provider node joining the network.
    uint8 public constant KIND_REGISTRATION = 1;
    /// Liveness ping from a node that is online and taking work.
    uint8 public constant KIND_HEARTBEAT = 2;
    /// A settled job: who paid whom, how much, and the hash of the result.
    uint8 public constant KIND_RECEIPT = 3;

    /// Matches the Hedera Consensus Service single-message limit this replaces.
    uint256 public constant MAX_PAYLOAD_BYTES = 1024;

    /**
     * One entry in the log.
     *
     * `kind` and `subject` are indexed so a reader can pull one node's
     * heartbeats or one job's receipt without scanning the whole log; `author`
     * is indexed so a reader can filter to writers it trusts. `seq` is a
     * network-wide monotonic counter, giving entries a stable ordinal the way
     * an HCS sequence number did — block/log index alone is awkward to quote.
     *
     * @param kind One of the KIND_ constants.
     * @param subject keccak256 of the node id or job id this concerns.
     * @param author The account that published the entry.
     * @param seq Monotonic network-wide sequence number, starting at 1.
     * @param payload The JSON envelope, identical in shape to the HCS one.
     */
    event Entry(
        uint8 indexed kind,
        bytes32 indexed subject,
        address indexed author,
        uint64 seq,
        string payload
    );

    /// Number of entries published. The `seq` of the most recent one.
    uint64 public count;

    error PayloadTooLarge(uint256 size, uint256 max);
    error UnknownKind(uint8 kind);

    /**
     * Publish one entry.
     *
     * @param kind One of the KIND_ constants; anything else reverts, so a
     *        caller with a bug fails loudly instead of writing an entry no
     *        reader will ever filter for.
     * @param subject keccak256 of the node id or job id.
     * @param payload The JSON envelope. Capped at MAX_PAYLOAD_BYTES.
     * @return seq The sequence number assigned to this entry.
     */
    function append(uint8 kind, bytes32 subject, string calldata payload)
        external
        returns (uint64 seq)
    {
        if (kind != KIND_REGISTRATION && kind != KIND_HEARTBEAT && kind != KIND_RECEIPT) {
            revert UnknownKind(kind);
        }
        uint256 size = bytes(payload).length;
        if (size > MAX_PAYLOAD_BYTES) revert PayloadTooLarge(size, MAX_PAYLOAD_BYTES);

        unchecked {
            seq = ++count;
        }
        emit Entry(kind, subject, msg.sender, seq, payload);
    }
}
