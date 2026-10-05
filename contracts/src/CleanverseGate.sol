// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IIdentityGate} from "./interfaces/IIdentityGate.sol";

/**
 * @title CleanverseGate
 * @notice Cleanverse CVI as Xorv's identity gate: an account is verified while
 *         it holds an active Cleanverse A-Pass.
 *
 * ## What "active" means, and where it is decided
 *
 * The A-Pass is Cleanverse's non-transferable identity credential, issued by
 * their compliance validator after KYC. The A-Pass contract itself answers
 * whether a holder's credential is valid right now (selector `0xf480b6f5`,
 * `(address) view returns (bool)`): true for an issued, unexpired credential,
 * false once it is frozen, revoked or past its expiry, and false for an
 * address that never had one. Read off the Monad testnet deployment
 * (`0xbA82D189…58B9`) by issuing, freezing, unfreezing, revoking and expiring
 * credentials on a fork, because the contract is not verified and the docs are
 * invite-only. This gate defers to that answer rather than re-deriving it from
 * the credential's fields, so a freeze by Cleanverse takes effect in Xorv in
 * the same block.
 *
 * ## The compliance validator
 *
 * With `pool` set, an account must also pass the validator's
 * `complianceVerify(pool, account)`, Cleanverse's per-pool rule check
 * (jurisdiction, level). That needs the pool registered with the validator,
 * which only Cleanverse can do; until then `pool` is zero and the A-Pass alone
 * decides. A validator that reverts or answers false fails the check closed.
 */
contract CleanverseGate is IIdentityGate {
    /// The A-Pass's "is this credential valid now" view.
    bytes4 internal constant APASS_IS_VALID = 0xf480b6f5;

    address public immutable apass;
    address public immutable validator;
    /// Pool registered with the validator; zero skips `complianceVerify`.
    address public immutable pool;

    error ZeroAddress();

    constructor(address apass_, address validator_, address pool_) {
        if (apass_ == address(0)) revert ZeroAddress();
        if (pool_ != address(0) && validator_ == address(0)) revert ZeroAddress();
        apass = apass_;
        validator = validator_;
        pool = pool_;
    }

    function isVerified(address account) external view returns (bool) {
        return hasValidAPass(account) && passesCompliance(account);
    }

    /// The A-Pass contract's own answer. Any failure to answer is a no.
    function hasValidAPass(address account) public view returns (bool) {
        (bool ok, bytes memory ret) = apass.staticcall(abi.encodeWithSelector(APASS_IS_VALID, account));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    /// `complianceVerify(pool, account)` when a pool is configured; true otherwise.
    function passesCompliance(address account) public view returns (bool) {
        if (pool == address(0)) return true;
        (bool ok, bytes memory ret) =
            validator.staticcall(abi.encodeWithSignature("complianceVerify(address,address)", pool, account));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }
}
