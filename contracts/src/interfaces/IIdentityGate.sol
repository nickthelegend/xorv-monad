// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * IIdentityGate — who may move value through the escrow.
 *
 * `XorvEscrow` asks the gate, when one is set, before money moves toward
 * someone: both parties when a job is funded, the payee when it is released or
 * handed to another provider. Refunds are never gated; they only ever return
 * money to a buyer the gate already let in.
 *
 * Implemented for Cleanverse CVI (A-Pass) by `CleanverseGate`.
 */
interface IIdentityGate {
    /// True when `account` holds a current, verified identity.
    function isVerified(address account) external view returns (bool);
}
