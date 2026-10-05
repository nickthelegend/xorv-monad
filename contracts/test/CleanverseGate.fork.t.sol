// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {CleanverseGate} from "../src/CleanverseGate.sol";

interface IAgoraFaucet {
    function requestFunds(address to) external;
}

interface IDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// The A-Pass functions this test drives, as Cleanverse's issuer calls them.
interface IAPassAdmin {
    function freeze(address account) external;
    function unfreeze(address account) external;
    function revoke(address account) external;
    function balanceOf(address account) external view returns (uint256);
}

/**
 * The CVI gate against Cleanverse's *real* contracts, on a fork of Monad testnet.
 *
 * Credentials are issued, frozen and revoked by impersonating Cleanverse's own
 * compliance validator, which holds the A-Pass ISSUER_ROLE. That happens only
 * on the local fork; nothing is sent to Monad. Money is real AUSD from Agora's
 * testnet faucet, so the escrow moves the same token it would in production.
 *
 *   FORK_TESTS=1 forge test --match-contract CleanverseGateFork
 */
contract CleanverseGateForkTest is Test {
    address internal constant APASS = 0xbA82D189540CaC9DC6FF46B6837CaC1BFdEC58B9;
    address internal constant VALIDATOR = 0xaC7e5179C2C7f03f209136886c172eb34F161792;
    address internal constant AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    address internal constant AGORA_FAUCET = 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C;
    bytes4 internal constant APASS_ISSUE = 0xb8dd3664;
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    uint256 internal constant BUYER_KEY = 0xC1EA4;
    uint256 internal constant PRICE = 250_000;

    XorvEscrow internal escrow;
    CleanverseGate internal gate;
    address internal attester = makeAddr("attester");
    address internal provider = makeAddr("cv-provider");
    address internal buyer;

    function _enabled() internal view returns (bool) {
        return vm.envOr("FORK_TESTS", false);
    }

    /// Issue an A-Pass the way Cleanverse's validator does: level 2, valid for a year.
    function _issue(address account) internal {
        vm.prank(VALIDATOR);
        (bool ok, bytes memory err) = APASS.call(
            abi.encodeWithSelector(
                APASS_ISSUE,
                account,
                uint8(2),
                uint8(50),
                bytes2(0),
                bytes2("CD"),
                uint64(block.timestamp + 365 days),
                uint256(keccak256(abi.encode("xorv-fork-kyc", account))),
                uint256(1)
            )
        );
        require(ok, string(err));
    }

    function _setUp() internal {
        vm.createSelectFork("monad_testnet");
        buyer = vm.addr(BUYER_KEY);
        address[] memory tokens = new address[](1);
        tokens[0] = AUSD;
        escrow = new XorvEscrow(address(this), attester, address(0), tokens);
        gate = new CleanverseGate(APASS, VALIDATOR, address(0));
        escrow.setIdentityGate(address(gate));

        vm.warp(block.timestamp + 61); // the faucet's 60 s global cooldown
        IAgoraFaucet(AGORA_FAUCET).requestFunds(buyer);
    }

    function _funding(bytes32 jobId) internal view returns (XorvEscrow.Funding memory f) {
        f.jobId = jobId;
        f.buyer = buyer;
        f.provider = provider;
        f.token = AUSD;
        f.amount = PRICE;
        f.deadline = uint40(block.timestamp + 30 minutes);
        f.validBefore = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, buyer, address(escrow), PRICE, 0, f.validBefore, escrow.fundingNonce(jobId, f.deadline))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IDomain(AUSD).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        f.signature = abi.encodePacked(r, s, v);
    }

    function test_fork_gateFollowsRealAPassLifecycle() public {
        if (!_enabled()) return;
        _setUp();

        // Nobody has an A-Pass yet: no job can be funded.
        assertFalse(gate.isVerified(buyer), "fresh buyer has no A-Pass");
        XorvEscrow.Funding memory f = _funding(keccak256("cv-job-1"));
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, buyer));
        vm.prank(attester);
        escrow.fund(f);

        // The buyer gets one; the provider still has none.
        _issue(buyer);
        assertEq(IAPassAdmin(APASS).balanceOf(buyer), 1, "A-Pass issued");
        assertTrue(gate.isVerified(buyer), "issued A-Pass verifies");
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, provider));
        vm.prank(attester);
        escrow.fund(f);

        // Both verified: the job funds in real AUSD.
        _issue(provider);
        uint256 before = IERC20(AUSD).balanceOf(buyer);
        vm.prank(attester);
        escrow.fund(f);
        assertEq(IERC20(AUSD).balanceOf(address(escrow)), PRICE, "funded in AUSD");

        // Cleanverse freezes the provider mid-job: the payout stops at the escrow.
        vm.prank(VALIDATOR);
        IAPassAdmin(APASS).freeze(provider);
        assertFalse(gate.isVerified(provider), "frozen A-Pass does not verify");
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, provider));
        vm.prank(attester);
        escrow.release(f.jobId, keccak256("result"));

        // Unfrozen, the same release goes through.
        vm.prank(VALIDATOR);
        IAPassAdmin(APASS).unfreeze(provider);
        vm.prank(attester);
        escrow.release(f.jobId, keccak256("result"));
        assertEq(IERC20(AUSD).balanceOf(provider), PRICE, "provider paid");
        assertEq(IERC20(AUSD).balanceOf(buyer), before - PRICE, "buyer debited");

        // A revoked buyer can't start another job.
        vm.prank(VALIDATOR);
        IAPassAdmin(APASS).revoke(buyer);
        assertFalse(gate.isVerified(buyer), "revoked A-Pass does not verify");
        XorvEscrow.Funding memory f2 = _funding(keccak256("cv-job-2"));
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, buyer));
        vm.prank(attester);
        escrow.fund(f2);
    }

    function test_fork_expiredAPassDoesNotVerify() public {
        if (!_enabled()) return;
        _setUp();
        _issue(provider);
        assertTrue(gate.isVerified(provider));
        vm.warp(block.timestamp + 366 days);
        assertFalse(gate.isVerified(provider), "past its expiry");
    }

    function test_fork_unregisteredPoolFailsClosed() public {
        if (!_enabled()) return;
        _setUp();
        _issue(buyer);
        // The real validator reverts PoolNotRegistered() for a pool Cleanverse hasn't registered.
        CleanverseGate pooled = new CleanverseGate(APASS, VALIDATOR, address(escrow));
        assertTrue(pooled.hasValidAPass(buyer));
        assertFalse(pooled.passesCompliance(buyer), "unregistered pool fails closed");
        assertFalse(pooled.isVerified(buyer));
    }
}
