// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReputationRegistry8004
/// @notice The one slice of the canonical ERC-8004 v2.0.0 Reputation Registry that XorvLedger needs.
/// @dev    giveFeedback needs no pre-authorisation: any address may call it, and the caller is
///         recorded as `clientAddress`. The single exception is self-feedback: the call reverts
///         with "Self-feedback not allowed" when msg.sender is the agent's owner or an approved
///         operator, and with ERC721NonexistentToken for an unknown agentId. value/valueDecimals
///         and tag1/tag2 are stored on-chain (one slot per short tag); endpoint, feedbackURI and
///         feedbackHash are only emitted in NewFeedback.
///
///         Monad: 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 (143),
///                0x8004B663056A597Dffe9eCcC1965A193B7388713 (10143).
interface IReputationRegistry8004 {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}
