// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {XorvRegistry} from "../src/XorvRegistry.sol";
import {IXorvRegistry} from "../src/interfaces/IXorvRegistry.sol";
import {MockERC3009} from "./mocks/MockERC3009.sol";

/// The real escrow wired to the real registry, as deployed on Monad: settlement writes reputation
/// in the same transaction, and a refund by the attester marks the provider.
contract XorvEscrowRegistryIntegrationTest is Test {
    XorvEscrow internal escrow;
    XorvRegistry internal registry;
    MockERC3009 internal ausd;

    address internal owner = makeAddr("owner");
    address internal attester = makeAddr("attester");
    address internal provider = makeAddr("provider");
    uint256 internal buyerKey = 0xB0B;
    address internal buyer;

    uint256 internal constant PRICE = 100_000; // $0.10 at 6 decimals

    function setUp() public {
        vm.warp(1_800_000_000);
        buyer = vm.addr(buyerKey);
        ausd = new MockERC3009("AUSD", "1");
        registry = new XorvRegistry(owner);
        address[] memory tokens = new address[](1);
        tokens[0] = address(ausd);
        escrow = new XorvEscrow(owner, attester, address(registry), tokens);
        vm.startPrank(owner);
        registry.setEscrow(address(escrow));
        registry.setOperator(attester);
        vm.stopPrank();
        vm.prank(attester);
        registry.registerFor(provider, keccak256("node"), "");
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

    function test_releaseWritesReputationInTheSameTransaction() public {
        _fund("job-1");
        vm.expectEmit(address(registry));
        emit IXorvRegistry.OutcomeRecorded(provider, true, PRICE, 1, 0);
        vm.prank(attester);
        escrow.release("job-1", keccak256("result"));

        assertEq(ausd.balanceOf(provider), PRICE);
        IXorvRegistry.Provider memory p = registry.getProvider(provider);
        assertEq(p.completed, 1);
        assertEq(p.earned, PRICE);
        assertEq(registry.score(provider), 6666);
    }

    function test_attesterRefundMarksTheProvider() public {
        _fund("job-2");
        vm.prank(attester);
        escrow.refund("job-2");
        assertEq(ausd.balanceOf(buyer), 10e6);
        assertEq(registry.getProvider(provider).failed, 1);
        assertEq(registry.score(provider), 3333);
    }

    function test_deadlineRefundByAnyoneDoesNotMarkTheProvider() public {
        _fund("job-3");
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(makeAddr("keeper"));
        escrow.refund("job-3");
        assertEq(ausd.balanceOf(buyer), 10e6);
        assertEq(registry.getProvider(provider).failed, 0);
    }

    function test_releaseFitsTheRegistryGasBudget() public {
        // The escrow caps the registry call; the first outcome for a provider is the most
        // expensive (cold slots), so measure that one directly.
        vm.prank(address(escrow));
        uint256 before = gasleft();
        registry.recordOutcome(makeAddr("fresh"), true, 1);
        uint256 used = before - gasleft();
        assertLt(used, escrow.REGISTRY_GAS_LIMIT());
    }
}
