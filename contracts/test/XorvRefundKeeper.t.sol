// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {XorvRegistry} from "../src/XorvRegistry.sol";
import {XorvRefundKeeper, IReceiver} from "../src/XorvRefundKeeper.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {MockERC3009} from "./mocks/MockERC3009.sol";

/// The CRE refund keeper against the real escrow and registry.
contract XorvRefundKeeperTest is Test {
    XorvEscrow internal escrow;
    XorvRegistry internal registry;
    XorvRefundKeeper internal keeper;
    MockERC3009 internal ausd;

    address internal owner = makeAddr("owner");
    address internal attester = makeAddr("attester");
    address internal provider = makeAddr("provider");
    address internal forwarder = makeAddr("keystone-forwarder");
    uint256 internal buyerKey = 0xB0B;
    address internal buyer;
    uint256 internal constant PRICE = 100_000;

    function setUp() public {
        vm.warp(1_800_000_000);
        buyer = vm.addr(buyerKey);
        ausd = new MockERC3009("Agora Dollar", "1");
        registry = new XorvRegistry(owner);
        address[] memory tokens = new address[](1);
        tokens[0] = address(ausd);
        escrow = new XorvEscrow(owner, attester, address(registry), tokens);
        vm.prank(owner);
        registry.setEscrow(address(escrow));
        keeper = new XorvRefundKeeper(address(escrow), forwarder, owner);
        ausd.mint(buyer, 10e6);
    }

    function _fund(bytes32 jobId) internal {
        uint40 deadline = uint40(block.timestamp + 30 minutes);
        bytes32 digest = ausd.hashReceive(
            buyer, address(escrow), PRICE, 0, block.timestamp + 1 hours, escrow.fundingNonce(jobId, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);
        XorvEscrow.Funding memory f = XorvEscrow.Funding({
            jobId: jobId,
            buyer: buyer,
            provider: provider,
            token: address(ausd),
            amount: PRICE,
            deadline: deadline,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            signature: abi.encodePacked(r, s, v)
        });
        vm.prank(attester);
        escrow.fund(f);
    }

    function _report(bytes32[] memory ids) internal {
        vm.prank(forwarder);
        keeper.onReport("", abi.encode(ids));
    }

    function test_refundsExpiredJobsToTheirBuyers() public {
        _fund("a");
        _fund("b");
        vm.warp(block.timestamp + 31 minutes);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = "a";
        ids[1] = "b";

        vm.expectEmit(address(keeper));
        emit XorvRefundKeeper.ReportProcessed(2, 2);
        _report(ids);

        assertEq(ausd.balanceOf(buyer), 10e6);
        assertEq(ausd.balanceOf(address(keeper)), 0);
        assertEq(uint8(escrow.getJob("a").status), uint8(XorvEscrow.Status.Refunded));
        // A deadline refund is no-fault: the provider's record is untouched.
        assertEq(registry.getProvider(provider).failed, 0);
    }

    function test_skipsJobsThatAreNotRefundableWithoutRevertingTheBatch() public {
        _fund("released");
        vm.prank(attester);
        escrow.release("released", keccak256("ok"));
        _fund("early"); // deadline still ahead
        bytes32[] memory ids = new bytes32[](3);
        ids[0] = "released";
        ids[1] = "early";
        ids[2] = "never-funded";

        vm.expectEmit(address(keeper));
        emit XorvRefundKeeper.ReportProcessed(3, 0);
        _report(ids);
        assertEq(uint8(escrow.getJob("early").status), uint8(XorvEscrow.Status.Funded));
        assertEq(ausd.balanceOf(provider), PRICE);
    }

    function test_onlyTheForwarderCanDeliverReports() public {
        _fund("a");
        vm.warp(block.timestamp + 31 minutes);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = "a";
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(abi.encodeWithSelector(XorvRefundKeeper.NotForwarder.selector, makeAddr("anyone")));
        keeper.onReport("", abi.encode(ids));
    }

    function test_batchIsBounded() public {
        bytes32[] memory ids = new bytes32[](51);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(XorvRefundKeeper.BatchTooLarge.selector, 51));
        keeper.onReport("", abi.encode(ids));
    }

    function test_ownerCanSwitchFromSimulationToProductionForwarder() public {
        address production = makeAddr("production-forwarder");
        vm.prank(makeAddr("anyone"));
        vm.expectRevert();
        keeper.setForwarder(production);
        vm.prank(owner);
        keeper.setForwarder(production);
        assertEq(keeper.forwarder(), production);
    }

    function test_advertisesTheReceiverInterface() public view {
        assertTrue(keeper.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(keeper.supportsInterface(type(IERC165).interfaceId));
        assertFalse(keeper.supportsInterface(0xdeadbeef));
    }
}
