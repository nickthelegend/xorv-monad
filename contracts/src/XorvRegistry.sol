// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXorvRegistry} from "./interfaces/IXorvRegistry.sol";

/**
 * XorvRegistry — provider registry and reputation ledger.
 *
 * A Solidity port of the Arbitrum Stylus (Rust) registry, with the same ABI, events,
 * errors and semantics. `XorvEscrow` moves the money and, in the same transaction,
 * calls `recordOutcome` here, so a provider's track record is written by the
 * settlement itself: it can be earned, never claimed.
 *
 * Roles:
 * - owner: configures `escrow` and `operator`, and can hand over ownership.
 * - operator: a relayer that sponsors onboarding (`registerFor`) and liveness
 *   (`heartbeatFor`) so providers need no gas. The owner may do both too.
 * - escrow: the only address allowed to call `recordOutcome`.
 *
 * Invariants:
 * - owner != 0 ⇔ initialized; ownership can never be transferred to zero.
 * - nodeId != 0 ⇔ the provider registered at least once. That is what
 *   `providerCount` counts; a record created only by `recordOutcome` is not counted.
 * - active ⇒ nodeId != 0.
 * - Counters and `earned` are monotonic and saturate instead of reverting, so
 *   outcome reporting can never brick settlement in the escrow.
 *
 * The contract makes no external calls, holds no funds and has no payable entry points.
 */
contract XorvRegistry is IXorvRegistry {
    /// Longest `metadataUri` accepted, in bytes. It is only emitted, but an unbounded
    /// string would let a caller inflate log data (and the operator's sponsored gas).
    uint256 public constant MAX_METADATA_LEN = 256;

    uint256 private constant BPS = 10_000;

    error Unauthorized(address caller);
    error AlreadyInitialized();
    error NotRegistered(address provider);
    error ZeroAddress();
    error InvalidNodeId();
    error Inactive(address provider);
    error MetadataTooLong(uint256 length);

    address private _owner;
    uint64 private _providerCount;
    address private _escrow;
    address private _operator;
    mapping(address => Provider) private _providers;

    /// Deploy-and-initialize in one transaction, so nobody can call `initialize` first.
    /// Pass address(0) to defer to `initialize` (for tooling that deploys without args).
    constructor(address owner_) {
        if (owner_ != address(0)) _init(owner_);
    }

    // ---------------------------------------------------------------- admin

    /// One-time setup. Reverts `AlreadyInitialized` if an owner is already set.
    function initialize(address owner_) external {
        _init(owner_);
    }

    /// Owner-only. Zero disables outcome reporting.
    function setEscrow(address escrow_) external {
        _onlyOwner();
        _escrow = escrow_;
        emit EscrowUpdated(escrow_);
    }

    /// Owner-only. Zero disables sponsored registration and heartbeats.
    function setOperator(address operator_) external {
        _onlyOwner();
        _operator = operator_;
        emit OperatorUpdated(operator_);
    }

    /// Owner-only. Rejects zero: renouncing would freeze escrow/operator forever and
    /// re-open `initialize` to anyone.
    function transferOwnership(address newOwner) external {
        _onlyOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ---------------------------------------------------------------- providers

    /// Self-service: msg.sender (the provider's payout address) joins, or re-joins.
    /// Re-registering updates nodeId and reactivates; counters and history are kept.
    function register(bytes32 nodeId, string calldata metadataUri) external {
        _register(msg.sender, nodeId, metadataUri);
    }

    /// Sponsored registration by the operator (or owner) so onboarding needs no provider gas.
    function registerFor(address provider, bytes32 nodeId, string calldata metadataUri) external {
        _onlyOperatorOrOwner();
        _register(provider, nodeId, metadataUri);
    }

    /// msg.sender leaves the network. Its history is kept and it can re-register later.
    function deactivate() external {
        Provider storage rec = _providers[msg.sender];
        if (rec.nodeId == bytes32(0)) revert NotRegistered(msg.sender);
        if (!rec.active) revert Inactive(msg.sender);
        rec.active = false;
        emit ProviderDeactivated(msg.sender);
    }

    /// Liveness ping from an active, registered msg.sender.
    function heartbeat() external {
        _heartbeat(msg.sender);
    }

    /// Liveness ping relayed by the operator (or owner) on a provider's behalf.
    function heartbeatFor(address provider) external {
        _onlyOperatorOrOwner();
        _heartbeat(provider);
    }

    /// Escrow-only: record a settled job. Creates the record if it does not exist (inactive,
    /// nodeId == 0, not counted). Deactivated providers still accrue: the job was accepted
    /// while they were live and its outcome is part of their history.
    function recordOutcome(address provider, bool success, uint256 amount) external {
        // A zero escrow disables reporting: no caller is address(0).
        if (msg.sender != _escrow) revert Unauthorized(msg.sender);
        if (provider == address(0)) revert ZeroAddress();

        Provider storage rec = _providers[provider];
        if (rec.registeredAt == 0) rec.registeredAt = uint64(block.timestamp);
        uint64 completed = rec.completed;
        uint64 failed = rec.failed;
        if (success) {
            if (completed != type(uint64).max) completed++;
            rec.completed = completed;
            uint256 earned = rec.earned;
            unchecked {
                uint256 sum = earned + amount;
                rec.earned = sum < earned ? type(uint256).max : sum;
            }
        } else {
            if (failed != type(uint64).max) failed++;
            rec.failed = failed;
        }
        emit OutcomeRecorded(provider, success, amount, completed, failed);
    }

    // ---------------------------------------------------------------- views

    /// The full record. All zeros for an unknown address.
    function getProvider(address provider) external view returns (Provider memory) {
        return _providers[provider];
    }

    function isActive(address provider) external view returns (bool) {
        return _providers[provider].active;
    }

    /// Laplace-smoothed success rate in basis points: (completed+1)*10000/(completed+failed+2).
    /// 5000 with no history; it moves with evidence and never reaches 0 or 10000.
    function score(address provider) external view returns (uint32) {
        Provider storage rec = _providers[provider];
        return laplaceScore(rec.completed, rec.failed);
    }

    function laplaceScore(uint64 completed, uint64 failed) public pure returns (uint32) {
        // Numerator < 2^78, denominator < 2^66: no overflow, result in [0, 10000].
        return uint32(((uint256(completed) + 1) * BPS) / (uint256(completed) + uint256(failed) + 2));
    }

    function providerCount() external view returns (uint64) {
        return _providerCount;
    }

    function owner() external view returns (address) {
        return _owner;
    }

    function escrow() external view returns (address) {
        return _escrow;
    }

    function operator() external view returns (address) {
        return _operator;
    }

    // ---------------------------------------------------------------- internals

    function _init(address owner_) private {
        if (_owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0)) revert ZeroAddress();
        _owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function _onlyOwner() private view {
        if (msg.sender != _owner) revert Unauthorized(msg.sender);
    }

    /// A zero operator never matches because no caller is address(0).
    function _onlyOperatorOrOwner() private view {
        if (msg.sender != _operator && msg.sender != _owner) revert Unauthorized(msg.sender);
    }

    function _register(address provider, bytes32 nodeId, string calldata metadataUri) private {
        if (provider == address(0)) revert ZeroAddress();
        if (nodeId == bytes32(0)) revert InvalidNodeId();
        if (bytes(metadataUri).length > MAX_METADATA_LEN) revert MetadataTooLong(bytes(metadataUri).length);

        Provider storage rec = _providers[provider];
        bool first = rec.nodeId == bytes32(0);
        // A record created by recordOutcome keeps its original creation time.
        if (rec.registeredAt == 0) rec.registeredAt = uint64(block.timestamp);
        rec.nodeId = nodeId;
        rec.lastSeen = uint64(block.timestamp);
        rec.active = true;
        if (first && _providerCount != type(uint64).max) _providerCount++;
        emit ProviderRegistered(provider, nodeId, metadataUri);
    }

    function _heartbeat(address provider) private {
        Provider storage rec = _providers[provider];
        if (rec.nodeId == bytes32(0)) revert NotRegistered(provider);
        if (!rec.active) revert Inactive(provider);
        rec.lastSeen = uint64(block.timestamp);
        emit Heartbeat(provider, uint64(block.timestamp));
    }
}
