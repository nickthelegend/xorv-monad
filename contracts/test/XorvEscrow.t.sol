// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {MockERC3009} from "./mocks/MockERC3009.sol";
import {MockRegistry, MockSmartWallet} from "./mocks/MockRegistry.sol";

contract XorvEscrowTestBase is Test {
    XorvEscrow internal escrow;
    MockERC3009 internal usdg;
    MockRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal attester = makeAddr("attester");
    address internal provider = makeAddr("provider");
    address internal provider2 = makeAddr("provider2");
    address internal stranger = makeAddr("stranger");
    address internal treasury = makeAddr("treasury");
    uint256 internal buyerKey = 0xB0B;
    address internal buyer;

    uint256 internal constant PRICE = 250_000; // $0.25 at 6 decimals
    bytes32 internal constant JOB = keccak256("job-1");
    // keccak, not sha256: sha256 is a precompile *call*, which would consume a vm.prank.
    bytes32 internal constant RESULT = keccak256("the answer");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        buyer = vm.addr(buyerKey);
        usdg = new MockERC3009("Global Dollar", "1");
        registry = new MockRegistry();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        escrow = new XorvEscrow(owner, attester, address(registry), tokens);
        registry.setEscrow(address(escrow));
        usdg.mint(buyer, 1_000e6);
    }

    function _deadline() internal view returns (uint40) {
        return uint40(block.timestamp + 30 minutes);
    }

    /// The buyer's signature, exactly as a wallet would produce it off-chain.
    function _sign(uint256 key, address from, uint256 amount, bytes32 jobId, uint40 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = usdg.hashReceive(
            from,
            address(escrow),
            amount,
            0,
            block.timestamp + 1 hours,
            escrow.fundingNonce(jobId, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _funding(bytes32 jobId, uint256 amount, uint40 deadline)
        internal
        view
        returns (XorvEscrow.Funding memory)
    {
        return XorvEscrow.Funding({
            jobId: jobId,
            buyer: buyer,
            provider: provider,
            token: address(usdg),
            amount: amount,
            deadline: deadline,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            signature: _sign(buyerKey, buyer, amount, jobId, deadline)
        });
    }

    function _fund(bytes32 jobId, uint256 amount) internal returns (uint40 deadline) {
        deadline = _deadline();
        XorvEscrow.Funding memory f = _funding(jobId, amount, deadline);
        vm.prank(attester);
        escrow.fund(f);
    }
}

contract XorvEscrowFundTest is XorvEscrowTestBase {
    function test_fund_movesMoneyIntoEscrowAndRecordsJob() public {
        uint40 deadline = _deadline();
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, deadline);

        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobFunded(JOB, buyer, provider, address(usdg), PRICE, deadline);
        vm.prank(attester);
        escrow.fund(f);

        assertEq(usdg.balanceOf(address(escrow)), PRICE);
        assertEq(usdg.balanceOf(buyer), 1_000e6 - PRICE);
        assertEq(escrow.totalEscrowed(address(usdg)), PRICE);

        XorvEscrow.Job memory job = escrow.getJob(JOB);
        assertEq(job.buyer, buyer);
        assertEq(job.provider, provider);
        assertEq(job.token, address(usdg));
        assertEq(job.amount, PRICE);
        assertEq(job.deadline, deadline);
        assertEq(uint8(job.status), uint8(XorvEscrow.Status.Funded));
    }

    function test_fund_buyerNeedsNoGas() public {
        // The buyer never sends a transaction and holds no ETH.
        assertEq(buyer.balance, 0);
        _fund(JOB, PRICE);
        assertEq(buyer.balance, 0);
    }

    function test_fund_onlyAttester() public {
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAttester.selector, stranger));
        escrow.fund(f);
    }

    function test_fund_revertsOnDuplicateJob() public {
        _fund(JOB, PRICE);
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.JobExists.selector, JOB));
        escrow.fund(f);
    }

    function test_fund_signatureCommitsToDeadline() public {
        // A relayer that moves the refund deadline changes the nonce, and the
        // buyer's signature no longer covers it.
        uint40 deadline = _deadline();
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, deadline);
        f.deadline = deadline + 1 days;
        vm.prank(attester);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.fund(f);
    }

    function test_fund_signatureCommitsToJobId() public {
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        f.jobId = keccak256("some-other-job");
        vm.prank(attester);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.fund(f);
    }

    function test_fund_signatureCommitsToAmount() public {
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        f.amount = PRICE * 4;
        vm.prank(attester);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.fund(f);
    }

    function test_fund_authorizationCannotBeFrontRun() public {
        // Someone who sees the signature cannot redeem it directly with the
        // token: receiveWithAuthorization only pays out to its caller.
        uint40 deadline = _deadline();
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, deadline);
        bytes32 nonce = escrow.fundingNonce(JOB, deadline);
        vm.prank(stranger);
        vm.expectRevert("FiatTokenV2: caller must be the payee");
        usdg.receiveWithAuthorization(
            buyer, address(escrow), PRICE, f.validAfter, f.validBefore, nonce, f.signature
        );
    }

    function test_fund_rejectsDisallowedToken() public {
        MockERC3009 other = new MockERC3009("Other", "1");
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        f.token = address(other);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.TokenNotAllowed.selector, address(other)));
        escrow.fund(f);
    }

    function test_fund_rejectsZeroAndOversizedAmounts() public {
        XorvEscrow.Funding memory f = _funding(JOB, 0, _deadline());
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidAmount.selector, 0));
        escrow.fund(f);

        uint256 huge = uint256(type(uint96).max) + 1;
        f = _funding(JOB, huge, _deadline());
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidAmount.selector, huge));
        escrow.fund(f);
    }

    function test_fund_rejectsSelfDealing() public {
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        f.provider = buyer;
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidParties.selector, buyer, buyer));
        escrow.fund(f);
    }

    function test_fund_rejectsDeadlinesOutsideWindow() public {
        uint40 tooSoon = uint40(block.timestamp + 30 seconds);
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, tooSoon);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidDeadline.selector, tooSoon));
        escrow.fund(f);

        uint40 tooLate = uint40(block.timestamp + 8 days);
        f = _funding(JOB, PRICE, tooLate);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidDeadline.selector, tooLate));
        escrow.fund(f);
    }

    function test_fund_rejectsFeeOnTransferToken() public {
        usdg.setTransferFeeBps(100);
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.AmountMismatch.selector, PRICE, PRICE - PRICE / 100)
        );
        escrow.fund(f);
    }

    function test_fund_blockedWhenPaused() public {
        vm.prank(owner);
        escrow.pause();
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, _deadline());
        vm.prank(attester);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.fund(f);
    }

    function test_fund_fromSmartContractWallet() public {
        // ERC-1271: a buyer paying from a smart account (e.g. an ERC-4337 wallet).
        MockSmartWallet wallet = new MockSmartWallet(buyer);
        usdg.mint(address(wallet), 10e6);
        uint40 deadline = _deadline();
        bytes32 digest = usdg.hashReceive(
            address(wallet),
            address(escrow),
            PRICE,
            0,
            block.timestamp + 1 hours,
            escrow.fundingNonce(JOB, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);

        XorvEscrow.Funding memory f = XorvEscrow.Funding({
            jobId: JOB,
            buyer: address(wallet),
            provider: provider,
            token: address(usdg),
            amount: PRICE,
            deadline: deadline,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            signature: abi.encode(v, r, s)
        });
        vm.prank(attester);
        escrow.fund(f);
        assertEq(escrow.getJob(JOB).buyer, address(wallet));
        assertEq(usdg.balanceOf(address(escrow)), PRICE);
    }

    function test_fundingNonce_isBoundToChainAndContract() public {
        bytes32 here = escrow.fundingNonce(JOB, 100);
        vm.chainId(46630);
        assertTrue(escrow.fundingNonce(JOB, 100) != here);
        vm.chainId(421614);
        address[] memory tokens = new address[](0);
        XorvEscrow twin = new XorvEscrow(owner, attester, address(0), tokens);
        assertTrue(twin.fundingNonce(JOB, 100) != escrow.fundingNonce(JOB, 100));
    }
}

contract XorvEscrowSettleTest is XorvEscrowTestBase {
    function test_release_byAttesterPaysProviderAndRecordsReputation() public {
        _fund(JOB, PRICE);

        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobReleased(JOB, provider, PRICE, 0, RESULT, attester);
        vm.prank(attester);
        escrow.release(JOB, RESULT);

        assertEq(usdg.balanceOf(provider), PRICE);
        assertEq(usdg.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalEscrowed(address(usdg)), 0);
        assertEq(uint8(escrow.getJob(JOB).status), uint8(XorvEscrow.Status.Released));
        assertEq(registry.completed(provider), 1);
        assertEq(registry.failed(provider), 0);
    }

    function test_release_byBuyerAnytime() public {
        uint40 deadline = _fund(JOB, PRICE);
        vm.warp(deadline + 1 days);
        vm.prank(buyer);
        escrow.release(JOB, RESULT);
        assertEq(usdg.balanceOf(provider), PRICE);
    }

    function test_release_attesterCannotReleaseAfterDeadline() public {
        uint40 deadline = _fund(JOB, PRICE);
        vm.warp(deadline + 1);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.DeadlinePassed.selector, JOB, deadline));
        escrow.release(JOB, RESULT);
    }

    function test_release_strangerCannotRelease() public {
        _fund(JOB, PRICE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAuthorized.selector, stranger));
        escrow.release(JOB, RESULT);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAuthorized.selector, provider));
        escrow.release(JOB, RESULT);
    }

    function test_release_takesSnapshottedFee() public {
        vm.prank(owner);
        escrow.setFee(250, treasury); // 2.5%
        _fund(JOB, PRICE);
        // Raising the fee after funding must not touch this job.
        vm.prank(owner);
        escrow.setFee(500, treasury);

        vm.prank(attester);
        escrow.release(JOB, RESULT);
        uint256 fee = (PRICE * 250) / 10_000;
        assertEq(usdg.balanceOf(treasury), fee);
        assertEq(usdg.balanceOf(provider), PRICE - fee);
    }

    function test_settledJobCannotSettleAgain() public {
        _fund(JOB, PRICE);
        vm.prank(attester);
        escrow.release(JOB, RESULT);

        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.JobNotFunded.selector, JOB, XorvEscrow.Status.Released)
        );
        escrow.release(JOB, RESULT);

        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.JobNotFunded.selector, JOB, XorvEscrow.Status.Released)
        );
        escrow.refund(JOB);
    }

    function test_unknownJobCannotSettle() public {
        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.JobNotFunded.selector, JOB, XorvEscrow.Status.None)
        );
        escrow.release(JOB, RESULT);
    }

    function test_refund_byAttesterAnytimeCountsAgainstProvider() public {
        _fund(JOB, PRICE);
        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobRefunded(JOB, buyer, PRICE, true);
        vm.prank(attester);
        escrow.refund(JOB);

        assertEq(usdg.balanceOf(buyer), 1_000e6);
        assertEq(escrow.totalEscrowed(address(usdg)), 0);
        assertEq(registry.failed(provider), 1);
    }

    function test_refund_anyoneAfterDeadlineWithoutBlame() public {
        uint40 deadline = _fund(JOB, PRICE);
        assertFalse(escrow.isRefundable(JOB));
        vm.warp(deadline + 1);
        assertTrue(escrow.isRefundable(JOB));

        vm.prank(stranger);
        escrow.refund(JOB);
        assertEq(usdg.balanceOf(buyer), 1_000e6);
        assertEq(usdg.balanceOf(stranger), 0);
        assertEq(registry.failed(provider), 0);
    }

    function test_refund_notBeforeDeadline() public {
        uint40 deadline = _fund(JOB, PRICE);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.DeadlineNotReached.selector, JOB, deadline));
        escrow.refund(JOB);
    }

    function test_cancel_refundsWithoutBlame() public {
        _fund(JOB, PRICE);
        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobRefunded(JOB, buyer, PRICE, false);
        vm.prank(attester);
        escrow.cancel(JOB);
        assertEq(usdg.balanceOf(buyer), 1_000e6);
        assertEq(escrow.totalEscrowed(address(usdg)), 0);
        assertEq(uint8(escrow.getJob(JOB).status), uint8(XorvEscrow.Status.Refunded));
        // A buyer calling it off is not the provider failing.
        assertEq(registry.failed(provider), 0);
        assertEq(registry.outcomeCount(), 0);
    }

    function test_cancel_onlyAttester() public {
        _fund(JOB, PRICE);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAttester.selector, buyer));
        escrow.cancel(JOB);
    }

    function test_cancel_notAfterSettlement() public {
        _fund(JOB, PRICE);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(XorvEscrow.JobNotFunded.selector, JOB, XorvEscrow.Status.Released)
        );
        escrow.cancel(JOB);
    }

    function test_refund_worksWhilePaused() public {
        uint40 deadline = _fund(JOB, PRICE);
        vm.prank(owner);
        escrow.pause();
        vm.warp(deadline + 1);
        escrow.refund(JOB);
        assertEq(usdg.balanceOf(buyer), 1_000e6);
    }

    function test_release_worksWhilePaused() public {
        _fund(JOB, PRICE);
        vm.prank(owner);
        escrow.pause();
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdg.balanceOf(provider), PRICE);
    }

    function test_reassign_movesPayeeAndBlamesPrevious() public {
        _fund(JOB, PRICE);
        vm.expectEmit(address(escrow));
        emit XorvEscrow.JobReassigned(JOB, provider, provider2);
        vm.prank(attester);
        escrow.reassign(JOB, provider2);

        assertEq(registry.failed(provider), 1);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdg.balanceOf(provider2), PRICE);
        assertEq(usdg.balanceOf(provider), 0);
    }

    function test_reassign_guards() public {
        uint40 deadline = _fund(JOB, PRICE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAttester.selector, stranger));
        escrow.reassign(JOB, provider2);

        vm.startPrank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidParties.selector, buyer, buyer));
        escrow.reassign(JOB, buyer);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.InvalidParties.selector, buyer, provider));
        escrow.reassign(JOB, provider);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.DeadlinePassed.selector, JOB, deadline));
        escrow.reassign(JOB, provider2);
        vm.stopPrank();
    }
}

contract XorvEscrowRegistryTest is XorvEscrowTestBase {
    function test_brokenRegistryNeverBlocksPayment() public {
        registry.setMode(MockRegistry.Mode.Revert);
        _fund(JOB, PRICE);
        vm.expectEmit(true, true, false, false, address(escrow));
        emit XorvEscrow.RegistryCallFailed(JOB, provider, "");
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdg.balanceOf(provider), PRICE);
    }

    function test_gasBurningRegistryNeverBlocksPayment() public {
        registry.setMode(MockRegistry.Mode.BurnGas);
        _fund(JOB, PRICE);
        vm.prank(attester);
        escrow.refund(JOB);
        assertEq(usdg.balanceOf(buyer), 1_000e6);
    }

    function test_starvingTheRegistryCallReverts() public {
        // Supplying just too little gas for the registry, hoping the payment
        // still completes without the reputation update, must not work.
        registry.setMode(MockRegistry.Mode.BurnGas);
        _fund(JOB, PRICE);
        vm.prank(attester);
        (bool ok,) = address(escrow).call{gas: 120_000}(
            abi.encodeCall(XorvEscrow.release, (JOB, RESULT))
        );
        assertFalse(ok);
        assertEq(uint8(escrow.getJob(JOB).status), uint8(XorvEscrow.Status.Funded));
    }

    /// Regression: found on a live dev node. A gas limit that covers the payment
    /// but not the registry used to succeed with the reputation update skipped.
    function test_underfundedGasNeverSkipsReputation() public {
        registry.setMode(MockRegistry.Mode.Expensive);
        _fund(JOB, PRICE);
        for (uint256 g = 60_000; g < 400_000; g += 10_000) {
            vm.prank(attester);
            (bool ok,) = address(escrow).call{gas: g}(
                abi.encodeCall(XorvEscrow.release, (JOB, RESULT))
            );
            if (ok) {
                // The first limit that succeeds must also have paid for the record.
                assertEq(registry.completed(provider), 1, "released without reputation");
                assertEq(usdg.balanceOf(provider), PRICE);
                return;
            }
            assertEq(registry.completed(provider), 0);
        }
        revert("release never succeeded");
    }

    function test_noRegistryIsFine() public {
        vm.prank(owner);
        escrow.setRegistry(address(0));
        _fund(JOB, PRICE);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdg.balanceOf(provider), PRICE);
        assertEq(registry.outcomeCount(), 0);
    }
}

contract XorvEscrowAdminTest is XorvEscrowTestBase {
    function test_adminIsOwnerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setAttester(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setRegistry(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setTokenAllowed(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setFee(1, stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.sweep(address(usdg), stranger);
        vm.stopPrank();
    }

    function test_feeIsCapped() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.FeeTooHigh.selector, 501));
        escrow.setFee(501, treasury);
        vm.expectRevert(XorvEscrow.ZeroAddress.selector);
        escrow.setFee(100, address(0));
        escrow.setFee(0, address(0));
        vm.stopPrank();
    }

    function test_sweepReachesOnlyExcess() public {
        _fund(JOB, PRICE);
        usdg.mint(address(escrow), 7e6); // sent by mistake

        vm.prank(owner);
        escrow.sweep(address(usdg), treasury);
        assertEq(usdg.balanceOf(treasury), 7e6);
        assertEq(usdg.balanceOf(address(escrow)), PRICE);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NothingToSweep.selector, address(usdg)));
        escrow.sweep(address(usdg), treasury);
    }

    function test_renounceIsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(XorvEscrow.RenounceDisabled.selector);
        escrow.renounceOwnership();
    }

    function test_ownershipTransferIsTwoStep() public {
        vm.prank(owner);
        escrow.transferOwnership(stranger);
        assertEq(escrow.owner(), owner);
        vm.prank(stranger);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), stranger);
    }

    function test_disallowingTokenStillLetsFundedJobsSettle() public {
        _fund(JOB, PRICE);
        vm.prank(owner);
        escrow.setTokenAllowed(address(usdg), false);
        vm.prank(attester);
        escrow.release(JOB, RESULT);
        assertEq(usdg.balanceOf(provider), PRICE);
    }

    function test_rotatingAttesterRevokesOldKey() public {
        _fund(JOB, PRICE);
        address next = makeAddr("next-attester");
        vm.prank(owner);
        escrow.setAttester(next);
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(XorvEscrow.NotAuthorized.selector, attester));
        escrow.release(JOB, RESULT);
        vm.prank(next);
        escrow.release(JOB, RESULT);
    }
}

contract XorvEscrowFuzzTest is XorvEscrowTestBase {
    function testFuzz_releaseSplitsExactly(uint96 amount, uint16 fee) public {
        amount = uint96(bound(amount, 1, 1_000e6));
        fee = uint16(bound(fee, 0, escrow.MAX_FEE_BPS()));
        vm.prank(owner);
        escrow.setFee(fee, treasury);

        _fund(JOB, amount);
        vm.prank(attester);
        escrow.release(JOB, RESULT);

        assertEq(usdg.balanceOf(provider) + usdg.balanceOf(treasury), amount);
        assertEq(usdg.balanceOf(address(escrow)), 0);
    }

    function testFuzz_refundReturnsEverything(uint96 amount, uint32 lateBy) public {
        amount = uint96(bound(amount, 1, 1_000e6));
        uint40 deadline = _fund(JOB, amount);
        vm.warp(uint256(deadline) + 1 + lateBy);
        escrow.refund(JOB);
        assertEq(usdg.balanceOf(buyer), 1_000e6);
    }

    function testFuzz_foreignSignerCannotFund(uint256 attackerKey) public {
        attackerKey = bound(attackerKey, 1, type(uint128).max);
        vm.assume(attackerKey != buyerKey);
        uint40 deadline = _deadline();
        XorvEscrow.Funding memory f = _funding(JOB, PRICE, deadline);
        f.signature = _sign(attackerKey, buyer, PRICE, JOB, deadline);
        vm.prank(attester);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.fund(f);
    }
}
