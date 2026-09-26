// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ERC1271WalletMock
/// @notice Test-only stand-in for a smart account (Safe, a passkey wallet, a Privy smart wallet):
///         it holds no key of its own and approves a signature when `signer` produced it over the
///         exact hash. That is enough to prove XorvLedger accepts ratings from a buyer that is a
///         contract, which an ecrecover-only check would reject.
contract ERC1271WalletMock is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }
}
