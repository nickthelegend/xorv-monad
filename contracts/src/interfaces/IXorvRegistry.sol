// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * IXorvRegistry — the provider registry and reputation ledger.
 *
 * Implemented in Rust as an Arbitrum Stylus contract (`contracts/stylus/registry`).
 * This interface is the whole contract between the two halves of the system:
 * `XorvEscrow` (Solidity) moves the money, and reports each job's outcome here,
 * so a provider's track record is written by the same transaction that paid or
 * refunded for the job — it cannot be claimed, only earned.
 *
 * Reputation is deliberately simple and entirely on chain: two counters and a
 * running total, plus a Laplace-smoothed success score computed in the contract.
 */
interface IXorvRegistry {
    /// A provider record as the registry stores it.
    struct Provider {
        bytes32 nodeId;
        uint64 registeredAt;
        uint64 lastSeen;
        uint64 completed;
        uint64 failed;
        uint256 earned;
        bool active;
    }

    event ProviderRegistered(address indexed provider, bytes32 indexed nodeId, string metadataUri);
    event ProviderDeactivated(address indexed provider);
    event Heartbeat(address indexed provider, uint64 timestamp);
    event OutcomeRecorded(
        address indexed provider, bool success, uint256 amount, uint64 completed, uint64 failed
    );
    event EscrowUpdated(address indexed escrow);
    event OperatorUpdated(address indexed operator);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// One-time setup. Reverts if already initialized.
    function initialize(address owner) external;

    /// Self-service: msg.sender (the provider's payout address) joins the network.
    function register(bytes32 nodeId, string calldata metadataUri) external;

    /// Sponsored: the operator registers a provider so onboarding needs no gas.
    function registerFor(address provider, bytes32 nodeId, string calldata metadataUri) external;

    /// msg.sender leaves the network. Its history is kept.
    function deactivate() external;

    /// Liveness ping from msg.sender, or by the operator on a provider's behalf.
    function heartbeat() external;
    function heartbeatFor(address provider) external;

    /// Only the escrow may call this. Creates the record if it does not exist.
    function recordOutcome(address provider, bool success, uint256 amount) external;

    function getProvider(address provider) external view returns (Provider memory);
    function isActive(address provider) external view returns (bool);

    /// Laplace-smoothed success rate in basis points: (completed+1)*10000/(completed+failed+2).
    /// A provider with no history scores 5000; it moves with evidence, never jumps to 100%.
    function score(address provider) external view returns (uint32);

    function providerCount() external view returns (uint64);

    function owner() external view returns (address);
    function escrow() external view returns (address);
    function operator() external view returns (address);
    function setEscrow(address escrow) external;
    function setOperator(address operator) external;
    function transferOwnership(address newOwner) external;
}
