// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {XorvRegistry} from "../src/XorvRegistry.sol";
import {IXorvRegistry} from "../src/interfaces/IXorvRegistry.sol";

/// The Solidity registry, held to the same behaviour the Rust/Stylus original was tested for.
contract XorvRegistryTest is Test {
    XorvRegistry internal reg;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal escrow = makeAddr("escrow");
    address internal provider = makeAddr("provider");
    address internal provider2 = makeAddr("provider2");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant NODE = keccak256("node-1");
    bytes32 internal constant NODE2 = keccak256("node-2");

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new XorvRegistry(owner);
        vm.startPrank(owner);
        reg.setEscrow(escrow);
        reg.setOperator(operator);
        vm.stopPrank();
    }

    function _unauthorized(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(XorvRegistry.Unauthorized.selector, who);
    }

    function _register(address who, bytes32 node) internal {
        vm.prank(who);
        reg.register(node, "ipfs://meta");
    }

    function _record(address who, bool ok, uint256 amount) internal {
        vm.prank(escrow);
        reg.recordOutcome(who, ok, amount);
    }

    // ---------------------------------------------------------------- initialization

    function test_constructor_setsOwnerAndEmits() public {
        vm.expectEmit();
        emit IXorvRegistry.OwnershipTransferred(address(0), owner);
        XorvRegistry r = new XorvRegistry(owner);
        assertEq(r.owner(), owner);
    }

    function test_constructor_blocksInitialize() public {
        vm.expectRevert(XorvRegistry.AlreadyInitialized.selector);
        reg.initialize(stranger);
    }

    function test_deferredInitialize_setsOwnerOnce() public {
        XorvRegistry r = new XorvRegistry(address(0));
        assertEq(r.owner(), address(0));
        vm.expectEmit(address(r));
        emit IXorvRegistry.OwnershipTransferred(address(0), owner);
        r.initialize(owner);
        assertEq(r.owner(), owner);
        vm.expectRevert(XorvRegistry.AlreadyInitialized.selector);
        r.initialize(stranger);
    }

    function test_initialize_rejectsZeroOwner() public {
        XorvRegistry r = new XorvRegistry(address(0));
        vm.expectRevert(XorvRegistry.ZeroAddress.selector);
        r.initialize(address(0));
    }

    function test_adminLockedBeforeInitialize() public {
        XorvRegistry r = new XorvRegistry(address(0));
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        r.setEscrow(stranger);
    }

    function test_freshRegistryDefaults() public {
        XorvRegistry r = new XorvRegistry(owner);
        assertEq(r.escrow(), address(0));
        assertEq(r.operator(), address(0));
        assertEq(r.providerCount(), 0);
        assertFalse(r.isActive(provider));
        assertEq(r.score(provider), 5000);
        IXorvRegistry.Provider memory p = r.getProvider(provider);
        assertEq(p.nodeId, bytes32(0));
        assertEq(p.registeredAt, 0);
        assertEq(p.earned, 0);
    }

    // ---------------------------------------------------------------- register

    function test_register_createsRecordAndCounts() public {
        vm.expectEmit(address(reg));
        emit IXorvRegistry.ProviderRegistered(provider, NODE, "ipfs://meta");
        _register(provider, NODE);
        IXorvRegistry.Provider memory p = reg.getProvider(provider);
        assertEq(p.nodeId, NODE);
        assertEq(p.registeredAt, block.timestamp);
        assertEq(p.lastSeen, block.timestamp);
        assertTrue(p.active);
        assertEq(reg.providerCount(), 1);
    }

    function test_register_rejectsZeroNodeId() public {
        vm.prank(provider);
        vm.expectRevert(XorvRegistry.InvalidNodeId.selector);
        reg.register(bytes32(0), "");
    }

    function test_register_metadataLengthCap() public {
        string memory ok = string(new bytes(256));
        vm.prank(provider);
        reg.register(NODE, ok);
        string memory tooLong = string(new bytes(257));
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(XorvRegistry.MetadataTooLong.selector, 257));
        reg.register(NODE, tooLong);
    }

    function test_register_capCountsBytesNotChars() public {
        // "é" is two bytes in UTF-8: 129 of them are 258 bytes.
        bytes memory b = new bytes(258);
        for (uint256 i; i < 258; i += 2) {
            b[i] = 0xC3;
            b[i + 1] = 0xA9;
        }
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(XorvRegistry.MetadataTooLong.selector, 258));
        reg.register(NODE, string(b));
    }

    function test_reregister_updatesNodeKeepsCounters() public {
        _register(provider, NODE);
        _record(provider, true, 100);
        vm.warp(block.timestamp + 1 days);
        _register(provider, NODE2);
        IXorvRegistry.Provider memory p = reg.getProvider(provider);
        assertEq(p.nodeId, NODE2);
        assertEq(p.completed, 1);
        assertEq(p.earned, 100);
        assertEq(p.registeredAt, block.timestamp - 1 days);
        assertEq(p.lastSeen, block.timestamp);
        assertEq(reg.providerCount(), 1);
    }

    function test_reregister_reactivates() public {
        _register(provider, NODE);
        vm.prank(provider);
        reg.deactivate();
        assertFalse(reg.isActive(provider));
        _register(provider, NODE);
        assertTrue(reg.isActive(provider));
        assertEq(reg.providerCount(), 1);
    }

    function test_providerCount_countsDistinctAddresses() public {
        _register(provider, NODE);
        _register(provider, NODE2);
        _register(provider2, NODE);
        assertEq(reg.providerCount(), 2);
    }

    function test_registerFor_byOperatorAndOwner() public {
        vm.prank(operator);
        reg.registerFor(provider, NODE, "");
        vm.prank(owner);
        reg.registerFor(provider2, NODE2, "");
        assertTrue(reg.isActive(provider));
        assertTrue(reg.isActive(provider2));
    }

    function test_registerFor_unauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        reg.registerFor(provider, NODE, "");
    }

    function test_registerFor_rejectsZeroProviderAndNode() public {
        vm.startPrank(operator);
        vm.expectRevert(XorvRegistry.ZeroAddress.selector);
        reg.registerFor(address(0), NODE, "");
        vm.expectRevert(XorvRegistry.InvalidNodeId.selector);
        reg.registerFor(provider, bytes32(0), "");
        vm.stopPrank();
    }

    function test_registerFor_operatorDisabled() public {
        vm.prank(owner);
        reg.setOperator(address(0));
        vm.prank(operator);
        vm.expectRevert(_unauthorized(operator));
        reg.registerFor(provider, NODE, "");
    }

    // ---------------------------------------------------------------- deactivate

    function test_deactivate_keepsHistory() public {
        _register(provider, NODE);
        _record(provider, true, 7);
        vm.expectEmit(address(reg));
        emit IXorvRegistry.ProviderDeactivated(provider);
        vm.prank(provider);
        reg.deactivate();
        IXorvRegistry.Provider memory p = reg.getProvider(provider);
        assertFalse(p.active);
        assertEq(p.nodeId, NODE);
        assertEq(p.completed, 1);
        assertEq(p.earned, 7);
    }

    function test_deactivate_unregisteredReverts() public {
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(XorvRegistry.NotRegistered.selector, provider));
        reg.deactivate();
    }

    function test_deactivate_recordCreatedByEscrowOnlyReverts() public {
        _record(provider, true, 1);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(XorvRegistry.NotRegistered.selector, provider));
        reg.deactivate();
    }

    function test_deactivate_twiceReverts() public {
        _register(provider, NODE);
        vm.prank(provider);
        reg.deactivate();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(XorvRegistry.Inactive.selector, provider));
        reg.deactivate();
    }

    // ---------------------------------------------------------------- heartbeat

    function test_heartbeat_updatesLastSeen() public {
        _register(provider, NODE);
        vm.warp(block.timestamp + 90);
        vm.expectEmit(address(reg));
        emit IXorvRegistry.Heartbeat(provider, uint64(block.timestamp));
        vm.prank(provider);
        reg.heartbeat();
        assertEq(reg.getProvider(provider).lastSeen, block.timestamp);
    }

    function test_heartbeat_requiresRegistered() public {
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(XorvRegistry.NotRegistered.selector, provider));
        reg.heartbeat();
    }

    function test_heartbeat_requiresActive() public {
        _register(provider, NODE);
        vm.prank(provider);
        reg.deactivate();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(XorvRegistry.Inactive.selector, provider));
        reg.heartbeat();
    }

    function test_heartbeatFor_byOperatorAndOwner() public {
        _register(provider, NODE);
        vm.warp(block.timestamp + 10);
        vm.prank(operator);
        reg.heartbeatFor(provider);
        assertEq(reg.getProvider(provider).lastSeen, block.timestamp);
        vm.warp(block.timestamp + 10);
        vm.prank(owner);
        reg.heartbeatFor(provider);
        assertEq(reg.getProvider(provider).lastSeen, block.timestamp);
    }

    function test_heartbeatFor_unauthorized() public {
        _register(provider, NODE);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        reg.heartbeatFor(provider);
    }

    function test_heartbeatFor_checksProviderState() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(XorvRegistry.NotRegistered.selector, provider));
        reg.heartbeatFor(provider);
        _register(provider, NODE);
        vm.prank(provider);
        reg.deactivate();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(XorvRegistry.Inactive.selector, provider));
        reg.heartbeatFor(provider);
    }

    // ---------------------------------------------------------------- outcomes

    function test_recordOutcome_successAndFailure() public {
        _register(provider, NODE);
        vm.expectEmit(address(reg));
        emit IXorvRegistry.OutcomeRecorded(provider, true, 250_000, 1, 0);
        _record(provider, true, 250_000);
        vm.expectEmit(address(reg));
        emit IXorvRegistry.OutcomeRecorded(provider, false, 0, 1, 1);
        _record(provider, false, 0);
        IXorvRegistry.Provider memory p = reg.getProvider(provider);
        assertEq(p.completed, 1);
        assertEq(p.failed, 1);
        assertEq(p.earned, 250_000);
        assertEq(reg.score(provider), 5000);
    }

    function test_recordOutcome_failureDoesNotAddEarnings() public {
        _register(provider, NODE);
        _record(provider, false, 999);
        assertEq(reg.getProvider(provider).earned, 0);
    }

    function test_recordOutcome_onlyEscrow() public {
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        reg.recordOutcome(provider, true, 1);
        vm.prank(owner);
        vm.expectRevert(_unauthorized(owner));
        reg.recordOutcome(provider, true, 1);
    }

    function test_recordOutcome_disabledWhenEscrowZero() public {
        vm.prank(owner);
        reg.setEscrow(address(0));
        vm.prank(escrow);
        vm.expectRevert(_unauthorized(escrow));
        reg.recordOutcome(provider, true, 1);
    }

    function test_recordOutcome_rejectsZeroProvider() public {
        vm.prank(escrow);
        vm.expectRevert(XorvRegistry.ZeroAddress.selector);
        reg.recordOutcome(address(0), true, 1);
    }

    function test_recordOutcome_createsUnregisteredRecord() public {
        _record(provider, true, 5);
        IXorvRegistry.Provider memory p = reg.getProvider(provider);
        assertEq(p.nodeId, bytes32(0));
        assertFalse(p.active);
        assertEq(p.registeredAt, block.timestamp);
        assertEq(p.completed, 1);
        assertEq(reg.providerCount(), 0);
        // Registering later keeps the original creation time and counts it once.
        vm.warp(block.timestamp + 1 hours);
        _register(provider, NODE);
        assertEq(reg.getProvider(provider).registeredAt, block.timestamp - 1 hours);
        assertEq(reg.providerCount(), 1);
    }

    function test_recordOutcome_onDeactivatedProviderStillAccrues() public {
        _register(provider, NODE);
        vm.prank(provider);
        reg.deactivate();
        _record(provider, true, 3);
        assertEq(reg.getProvider(provider).completed, 1);
        assertFalse(reg.isActive(provider));
    }

    function test_recordOutcome_zeroAmountSuccess() public {
        _record(provider, true, 0);
        assertEq(reg.getProvider(provider).completed, 1);
        assertEq(reg.getProvider(provider).earned, 0);
    }

    function test_earnedSaturatesInsteadOfReverting() public {
        _record(provider, true, type(uint256).max - 1);
        _record(provider, true, 10);
        assertEq(reg.getProvider(provider).earned, type(uint256).max);
        assertEq(reg.getProvider(provider).completed, 2);
    }

    // ---------------------------------------------------------------- score

    function test_scoreFormula() public {
        for (uint256 i; i < 8; i++) _record(provider, true, 1);
        for (uint256 i; i < 2; i++) _record(provider, false, 0);
        // (8+1)*10000/(10+2) = 7500
        assertEq(reg.score(provider), 7500);
    }

    function test_laplaceScoreEdgeCases() public view {
        assertEq(reg.laplaceScore(0, 0), 5000);
        assertEq(reg.laplaceScore(1, 0), 6666);
        assertEq(reg.laplaceScore(0, 1), 3333);
        assertEq(reg.laplaceScore(type(uint64).max, 0), 9999);
        assertEq(reg.laplaceScore(0, type(uint64).max), 0);
        assertEq(reg.laplaceScore(type(uint64).max, type(uint64).max), 5000);
    }

    function testFuzz_scoreIsBounded(uint64 c, uint64 f) public view {
        uint32 s = reg.laplaceScore(c, f);
        assertLe(s, 10_000);
        if (c > f) assertGe(s, 5000);
        if (f > c) assertLe(s, 5000);
    }

    // ---------------------------------------------------------------- admin

    function test_setEscrowAndOperatorEmit() public {
        vm.startPrank(owner);
        vm.expectEmit(address(reg));
        emit IXorvRegistry.EscrowUpdated(provider);
        reg.setEscrow(provider);
        vm.expectEmit(address(reg));
        emit IXorvRegistry.OperatorUpdated(provider2);
        reg.setOperator(provider2);
        vm.stopPrank();
        assertEq(reg.escrow(), provider);
        assertEq(reg.operator(), provider2);
    }

    function test_adminFunctionsOnlyOwner() public {
        vm.startPrank(operator);
        vm.expectRevert(_unauthorized(operator));
        reg.setEscrow(stranger);
        vm.expectRevert(_unauthorized(operator));
        reg.setOperator(stranger);
        vm.expectRevert(_unauthorized(operator));
        reg.transferOwnership(stranger);
        vm.stopPrank();
    }

    function test_transferOwnershipMovesControl() public {
        vm.expectEmit(address(reg));
        emit IXorvRegistry.OwnershipTransferred(owner, stranger);
        vm.prank(owner);
        reg.transferOwnership(stranger);
        assertEq(reg.owner(), stranger);
        vm.prank(owner);
        vm.expectRevert(_unauthorized(owner));
        reg.setEscrow(owner);
        vm.prank(stranger);
        reg.setEscrow(owner);
        assertEq(reg.escrow(), owner);
        // The old owner also loses the operator privilege that owners have.
        vm.prank(owner);
        vm.expectRevert(_unauthorized(owner));
        reg.registerFor(provider, NODE, "");
    }

    function test_transferOwnershipRejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(XorvRegistry.ZeroAddress.selector);
        reg.transferOwnership(address(0));
        assertEq(reg.owner(), owner);
    }

    function test_failedCallsEmitNothing() public {
        vm.recordLogs();
        vm.prank(stranger);
        try reg.registerFor(provider, NODE, "") {} catch {}
        vm.prank(provider);
        try reg.heartbeat() {} catch {}
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_interfaceSelectorsMatch() public view {
        // The escrow and the off-chain broker call the registry through IXorvRegistry; the
        // Solidity port must answer every one of its selectors.
        IXorvRegistry i = IXorvRegistry(address(reg));
        assertEq(i.owner(), owner);
        assertEq(i.escrow(), escrow);
        assertEq(i.operator(), operator);
        assertEq(i.providerCount(), 0);
        assertEq(i.score(provider), 5000);
    }
}
