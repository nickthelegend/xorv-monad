// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {CleanverseGate} from "../src/CleanverseGate.sol";
import {XorvEscrowTestBase} from "./XorvEscrow.t.sol";
import {MockAPass, MockValidator} from "./mocks/MockAPass.sol";

contract CleanverseGateTest is XorvEscrowTestBase {
    MockAPass internal apass;
    CleanverseGate internal gate;

    function setUp() public override {
        super.setUp();
        apass = new MockAPass();
        gate = new CleanverseGate(address(apass), address(0), address(0));
        vm.prank(owner);
        escrow.setIdentityGate(address(gate));
        apass.set(buyer, true);
        apass.set(provider, true);
    }

    function test_gateOff_byDefault() public {
        address[] memory tokens = new address[](0);
        XorvEscrow fresh = new XorvEscrow(owner, attester, address(0), tokens);
        assertEq(address(fresh.identityGate()), address(0));
    }

    function test_setIdentityGate_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        escrow.setIdentityGate(address(0));

        vm.expectEmit(address(escrow));
        emit XorvEscrow.IdentityGateUpdated(address(gate), address(0));
        vm.prank(owner);
        escrow.setIdentityGate(address(0));
    }

    function test_fund_bothVerified_succeeds() public {
        _fund(JOB, PRICE);
        assertEq(usdg.balanceOf(address(escrow)), PRICE);
    }

    function test_fund_rejectsUnverifiedBuyer() public {
        apass.set(buyer, false);
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, buyer));
        vm.prank(attester);
        escrow.fund(f);
        assertEq(usdg.balanceOf(buyer), 1_000e6, "no money moved");
    }

    function test_fund_rejectsUnverifiedProvider() public {
        apass.set(provider, false);
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, provider));
        vm.prank(attester);
        escrow.fund(f);
    }

    function test_release_blockedWhileProviderFrozen_thenPaysOnceRestored() public {
        _fund(JOB, PRICE);
        apass.set(provider, false); // Cleanverse froze the provider's A-Pass mid-job

        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, provider));
        vm.prank(attester);
        escrow.release(JOB, RESULT);

        // The buyer can't push the payment through either.
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, provider));
        vm.prank(buyer);
        escrow.release(JOB, RESULT);

        apass.set(provider, true);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdg.balanceOf(provider), PRICE);
    }

    function test_refund_neverGated() public {
        _fund(JOB, PRICE);
        apass.set(buyer, false);
        apass.set(provider, false);
        vm.prank(attester);
        escrow.refund(JOB);
        assertEq(usdg.balanceOf(buyer), 1_000e6, "buyer made whole despite a lapsed credential");
    }

    function test_cancel_neverGated() public {
        _fund(JOB, PRICE);
        apass.set(buyer, false);
        vm.prank(attester);
        escrow.cancel(JOB);
        assertEq(usdg.balanceOf(buyer), 1_000e6);
    }

    function test_reassign_requiresVerifiedNewProvider() public {
        _fund(JOB, PRICE);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, provider2));
        vm.prank(attester);
        escrow.reassign(JOB, provider2);

        apass.set(provider2, true);
        vm.prank(attester);
        escrow.reassign(JOB, provider2);
        assertEq(escrow.getJob(JOB).provider, provider2);
    }

    function test_gate_failsClosedOnBrokenAPass() public {
        CleanverseGate broken = new CleanverseGate(address(0xdead), address(0), address(0));
        assertFalse(broken.isVerified(buyer));
    }

    function test_gate_withPool_requiresCompliance() public {
        MockValidator validator = new MockValidator();
        CleanverseGate pooled = new CleanverseGate(address(apass), address(validator), address(0xB001));
        assertFalse(pooled.isVerified(buyer), "A-Pass alone is not enough once a pool is set");
        validator.set(buyer, true);
        assertTrue(pooled.isVerified(buyer));
        apass.set(buyer, false);
        assertFalse(pooled.isVerified(buyer), "and compliance alone is not enough");
        apass.set(buyer, true);
        validator.setReverts(true);
        assertFalse(pooled.isVerified(buyer), "a reverting validator fails closed");
    }

    function test_constructor_rejectsZeroAPass() public {
        vm.expectRevert(CleanverseGate.ZeroAddress.selector);
        new CleanverseGate(address(0), address(0), address(0));
        vm.expectRevert(CleanverseGate.ZeroAddress.selector);
        new CleanverseGate(address(apass), address(0), address(0xB001));
    }

    function testFuzz_fund_onlyWhenBothVerified(bool buyerOk, bool providerOk) public {
        apass.set(buyer, buyerOk);
        apass.set(provider, providerOk);
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        if (!buyerOk) vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, buyer));
        else if (!providerOk) vm.expectRevert(abi.encodeWithSelector(XorvEscrow.IdentityNotVerified.selector, provider));
        vm.prank(attester);
        escrow.fund(f);
        assertEq(usdg.balanceOf(address(escrow)), buyerOk && providerOk ? PRICE : 0);
    }
}
