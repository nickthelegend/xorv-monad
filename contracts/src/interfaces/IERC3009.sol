// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The slice of EIP-3009 ("Transfer With Authorization") that XorvEscrow uses.
 *
 * Both stablecoins Xorv settles in implement it: Circle's USDC (FiatTokenV2_2)
 * and Paxos' USDG, where it lives in a facet behind the token proxy. The
 * `bytes signature` overloads are used rather than `(v, r, s)` because they
 * also accept ERC-1271 signatures, so a buyer paying from a smart-contract
 * wallet works with no extra code.
 */
interface IERC3009 {
    /**
     * Pull `value` from `from` into `to`, authorized by `from`'s signature over
     * an EIP-712 `ReceiveWithAuthorization` message.
     *
     * Unlike `transferWithAuthorization`, the token requires `msg.sender == to`.
     * That is the property escrow depends on: an authorization naming the
     * escrow as payee can only ever be executed *by* the escrow, so it cannot
     * be front-run into a bare transfer that lands funds without a job.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    /// True once `nonce` has been used or cancelled by `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
