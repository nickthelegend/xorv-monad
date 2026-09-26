// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IIdentityRegistry8004
/// @notice The one slice of the canonical ERC-8004 v2.0.0 Identity Registry that XorvLedger needs.
/// @dev    The registry keeps a verified payout wallet per agent under the reserved "agentWallet"
///         metadata key. It defaults to whoever registered the agent, can only be changed with a
///         signature from the new wallet, and is cleared (reads back as address(0)) whenever the
///         agent NFT is transferred. It also reads back as address(0) for an agentId that was never
///         minted: the getter does not revert. Callers must therefore treat address(0) as "no
///         verified wallet", never as a wallet.
///
///         Monad: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 (143),
///                0x8004A818BFB912233c491871b3d84c89A494BD9e (10143).
interface IIdentityRegistry8004 {
    function getAgentWallet(uint256 agentId) external view returns (address);
}
