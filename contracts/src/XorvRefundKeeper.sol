// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// The Chainlink CRE consumer interface: the KeystoneForwarder delivers a DON-signed report here.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IXorvEscrowRefund {
    function refund(bytes32 jobId) external;
    function isRefundable(bytes32 jobId) external view returns (bool);
}

/**
 * XorvRefundKeeper — buyers get their money back even if the broker disappears.
 *
 * XorvEscrow lets *anyone* refund a job once its deadline passes; the money can
 * only go to the buyer who paid. That guarantee is only as good as someone
 * actually calling `refund`. This contract is that someone, driven by a Chainlink
 * CRE workflow (`cre/refund-keeper`): on a schedule, the DON finds funded jobs
 * past their deadline (from the Envio index), checks each against the escrow on
 * chain, reaches consensus, and delivers the list here through the
 * KeystoneForwarder. The keeper calls `refund` for each.
 *
 * It holds no funds and has no say over where money goes: `refund` pays the
 * buyer recorded at funding, and a refund after the deadline never counts
 * against the provider. A job that is no longer refundable (released, already
 * refunded, deadline not reached) is skipped, not reverted, so one stale entry
 * can't sink a batch.
 */
contract XorvRefundKeeper is IReceiver, Ownable2Step {
    /// Most jobs refunded per report, so a report's gas stays bounded.
    uint256 public constant MAX_BATCH = 50;

    IXorvEscrowRefund public immutable escrow;
    /// The KeystoneForwarder allowed to deliver reports (the MockKeystoneForwarder while simulating).
    address public forwarder;

    event ForwarderUpdated(address indexed previous, address indexed forwarder);
    event KeeperRefunded(bytes32 indexed jobId);
    event KeeperSkipped(bytes32 indexed jobId, bytes reason);
    event ReportProcessed(uint256 requested, uint256 refunded);

    error NotForwarder(address caller);
    error BatchTooLarge(uint256 size);
    error ZeroAddress();

    constructor(address escrow_, address forwarder_, address owner_) Ownable(owner_) {
        if (escrow_ == address(0) || forwarder_ == address(0)) revert ZeroAddress();
        escrow = IXorvEscrowRefund(escrow_);
        forwarder = forwarder_;
        emit ForwarderUpdated(address(0), forwarder_);
    }

    /// Owner-only: move from the simulation forwarder to the production one (or back).
    function setForwarder(address forwarder_) external onlyOwner {
        if (forwarder_ == address(0)) revert ZeroAddress();
        emit ForwarderUpdated(forwarder, forwarder_);
        forwarder = forwarder_;
    }

    /// @param report abi.encode(bytes32[] jobIds) — the expired jobs the DON agreed on.
    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        bytes32[] memory jobIds = abi.decode(report, (bytes32[]));
        if (jobIds.length > MAX_BATCH) revert BatchTooLarge(jobIds.length);

        uint256 refunded;
        for (uint256 i; i < jobIds.length; ++i) {
            bytes32 jobId = jobIds[i];
            try escrow.refund(jobId) {
                ++refunded;
                emit KeeperRefunded(jobId);
            } catch (bytes memory reason) {
                emit KeeperSkipped(jobId, reason);
            }
        }
        emit ReportProcessed(jobIds.length, refunded);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
