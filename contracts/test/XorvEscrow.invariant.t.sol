// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {MockERC3009} from "./mocks/MockERC3009.sol";
import {MockRegistry} from "./mocks/MockRegistry.sol";

/**
 * Drives the escrow through random sequences of fund / release / refund /
 * reassign / time travel, tracking what *should* be held with ghost variables.
 */
contract EscrowHandler is Test {
    XorvEscrow public immutable escrow;
    MockERC3009 public immutable token;
    address public immutable attester;
    address public immutable treasury;

    uint256[] internal buyerKeys;
    address[] public providers;
    bytes32[] public jobIds;

    uint256 public ghostFunded;
    uint256 public ghostPaidOut;
    uint256 public ghostRefunded;
    uint256 public ghostFees;
    uint256 public ghostEscrowed;
    uint256 public ghostMinted;
    uint256 internal nextJob;

    constructor(XorvEscrow escrow_, MockERC3009 token_, address attester_, address treasury_) {
        escrow = escrow_;
        token = token_;
        attester = attester_;
        treasury = treasury_;
        for (uint256 i = 1; i <= 4; ++i) {
            buyerKeys.push(0xA11CE + i);
            providers.push(makeAddr(string.concat("provider", vm.toString(i))));
        }
    }

    function actors() external view returns (address[] memory all) {
        all = new address[](buyerKeys.length + providers.length);
        for (uint256 i = 0; i < buyerKeys.length; ++i) all[i] = vm.addr(buyerKeys[i]);
        for (uint256 i = 0; i < providers.length; ++i) all[buyerKeys.length + i] = providers[i];
    }

    function fund(uint256 buyerSeed, uint256 providerSeed, uint256 amount, uint256 duration)
        external
    {
        uint256 key = buyerKeys[buyerSeed % buyerKeys.length];
        address buyer = vm.addr(key);
        address provider = providers[providerSeed % providers.length];
        amount = bound(amount, 1, 50e6);
        uint40 deadline = uint40(block.timestamp + bound(duration, 2 minutes, 3 days));
        bytes32 jobId = keccak256(abi.encode("job", nextJob++));

        token.mint(buyer, amount);
        ghostMinted += amount;

        bytes32 digest = token.hashReceive(
            buyer,
            address(escrow),
            amount,
            0,
            block.timestamp + 1 hours,
            escrow.fundingNonce(jobId, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        XorvEscrow.Funding memory f = XorvEscrow.Funding({
            jobId: jobId,
            buyer: buyer,
            provider: provider,
            token: address(token),
            amount: amount,
            deadline: deadline,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            signature: abi.encodePacked(r, s, v)
        });
        vm.prank(attester);
        escrow.fund(f);
        jobIds.push(jobId);
        ghostFunded += amount;
        ghostEscrowed += amount;
    }

    function release(uint256 jobSeed, bool asBuyer) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[jobSeed % jobIds.length];
        XorvEscrow.Job memory job = escrow.getJob(jobId);
        if (job.status != XorvEscrow.Status.Funded) return;
        if (!asBuyer && block.timestamp > job.deadline) return;

        uint256 treasuryBefore = token.balanceOf(treasury);
        vm.prank(asBuyer ? job.buyer : attester);
        escrow.release(jobId, keccak256(abi.encode(jobId)));
        uint256 fee = token.balanceOf(treasury) - treasuryBefore;
        ghostFees += fee;
        ghostPaidOut += job.amount - fee;
        ghostEscrowed -= job.amount;
    }

    function refund(uint256 jobSeed, bool asAttester) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[jobSeed % jobIds.length];
        XorvEscrow.Job memory job = escrow.getJob(jobId);
        if (job.status != XorvEscrow.Status.Funded) return;
        if (!asAttester && block.timestamp <= job.deadline) return;

        vm.prank(asAttester ? attester : address(0xBEEF));
        escrow.refund(jobId);
        ghostRefunded += job.amount;
        ghostEscrowed -= job.amount;
    }

    function cancel(uint256 jobSeed) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[jobSeed % jobIds.length];
        XorvEscrow.Job memory job = escrow.getJob(jobId);
        if (job.status != XorvEscrow.Status.Funded) return;
        vm.prank(attester);
        escrow.cancel(jobId);
        ghostRefunded += job.amount;
        ghostEscrowed -= job.amount;
    }

    function reassign(uint256 jobSeed, uint256 providerSeed) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[jobSeed % jobIds.length];
        XorvEscrow.Job memory job = escrow.getJob(jobId);
        address next = providers[providerSeed % providers.length];
        if (
            job.status != XorvEscrow.Status.Funded || block.timestamp > job.deadline
                || next == job.provider
        ) return;
        vm.prank(attester);
        escrow.reassign(jobId, next);
    }

    function setFee(uint16 bps) external {
        bps = uint16(bound(bps, 0, escrow.MAX_FEE_BPS()));
        vm.prank(escrow.owner());
        escrow.setFee(bps, treasury);
    }

    function warp(uint256 by) external {
        vm.warp(block.timestamp + bound(by, 1, 2 days));
    }

    function jobCount() external view returns (uint256) {
        return jobIds.length;
    }
}

contract XorvEscrowInvariantTest is Test {
    XorvEscrow internal escrow;
    MockERC3009 internal token;
    EscrowHandler internal handler;
    address internal attester = makeAddr("attester");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockERC3009("Global Dollar", "1");
        MockRegistry registry = new MockRegistry();
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        escrow = new XorvEscrow(address(this), attester, address(registry), tokens);
        registry.setEscrow(address(escrow));
        handler = new EscrowHandler(escrow, token, attester, treasury);
        escrow.transferOwnership(address(handler));
        vm.prank(address(handler));
        escrow.acceptOwnership();

        targetContract(address(handler));
    }

    /// The escrow always holds at least what it owes.
    function invariant_solvent() public view {
        assertGe(token.balanceOf(address(escrow)), escrow.totalEscrowed(address(token)));
    }

    /// Its own accounting matches an independent tally of open jobs.
    function invariant_accountingMatchesGhost() public view {
        assertEq(escrow.totalEscrowed(address(token)), handler.ghostEscrowed());
    }

    /// Every unit funded is exactly one of: still escrowed, paid out, refunded, or fee.
    function invariant_moneyIsConserved() public view {
        assertEq(
            handler.ghostFunded(),
            handler.ghostEscrowed() + handler.ghostPaidOut() + handler.ghostRefunded()
                + handler.ghostFees()
        );
    }

    /// No token is created or destroyed across all participants.
    function invariant_supplyIsConserved() public view {
        address[] memory all = handler.actors();
        uint256 sum = token.balanceOf(address(escrow)) + token.balanceOf(treasury);
        for (uint256 i = 0; i < all.length; ++i) sum += token.balanceOf(all[i]);
        assertEq(sum, handler.ghostMinted());
        assertEq(token.totalSupply(), handler.ghostMinted());
    }
}
