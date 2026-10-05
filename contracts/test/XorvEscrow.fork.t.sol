// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";

interface IDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/**
 * The escrow against the *real* stablecoins, on forks of the live testnets.
 *
 * The mock proves the logic; this proves the integration. Paxos' USDG keeps
 * EIP-3009 in a facet behind its proxy and exposes no `version()`, so the one
 * way to be sure a buyer's signature lands is to sign exactly as a wallet
 * would, against the token's own DOMAIN_SEPARATOR, and let the token decide.
 *
 * Skipped unless FORK_TESTS=1, so `forge test` stays offline by default:
 *   FORK_TESTS=1 forge test --match-contract Fork
 */
contract XorvEscrowForkTest is Test {
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint256 internal constant BUYER_KEY = 0xB0B;
    uint256 internal constant PRICE = 250_000;

    struct Case {
        string rpc;
        address token;
        string name;
        string version;
    }

    function _cases() internal pure returns (Case[3] memory) {
        return [
            Case("arbitrum_sepolia", 0xFFC95faa3d63Cde504a05B567C600B78C0b41892, "Global Dollar", "1"),
            Case("arbitrum_sepolia", 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d, "USD Coin", "2"),
            Case("robinhood_testnet", 0x7E955252E15c84f5768B83c41a71F9eba181802F, "Global Dollar", "1")
        ];
    }

    function _enabled() internal view returns (bool) {
        return vm.envOr("FORK_TESTS", false);
    }

    function test_fork_domainsMatchConfiguredValues() public {
        if (!_enabled()) return;
        Case[3] memory cases = _cases();
        for (uint256 i = 0; i < cases.length; ++i) {
            vm.createSelectFork(cases[i].rpc);
            bytes32 expected = keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes(cases[i].name)),
                    keccak256(bytes(cases[i].version)),
                    block.chainid,
                    cases[i].token
                )
            );
            assertEq(IDomain(cases[i].token).DOMAIN_SEPARATOR(), expected, cases[i].name);
        }
    }

    function test_fork_fullLifecycleAgainstRealTokens() public {
        if (!_enabled()) return;
        Case[3] memory cases = _cases();
        for (uint256 i = 0; i < cases.length; ++i) {
            _lifecycle(cases[i]);
        }
    }

    /// Sign exactly as a wallet would: against the token's own on-chain domain.
    function _signedFunding(
        XorvEscrow escrow,
        address token,
        address buyer,
        address provider,
        bytes32 jobId
    ) internal view returns (XorvEscrow.Funding memory f) {
        f.jobId = jobId;
        f.buyer = buyer;
        f.provider = provider;
        f.token = token;
        f.amount = PRICE;
        f.deadline = uint40(block.timestamp + 30 minutes);
        f.validBefore = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_TYPEHASH,
                buyer,
                address(escrow),
                PRICE,
                0,
                f.validBefore,
                escrow.fundingNonce(jobId, f.deadline)
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", IDomain(token).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        f.signature = abi.encodePacked(r, s, v);
    }

    function _lifecycle(Case memory c) internal {
        vm.createSelectFork(c.rpc);
        address buyer = vm.addr(BUYER_KEY);
        address attester = makeAddr("attester");
        address provider = makeAddr("provider");

        address[] memory tokens = new address[](1);
        tokens[0] = c.token;
        XorvEscrow escrow = new XorvEscrow(address(this), attester, address(0), tokens);

        // Give the buyer a balance by writing the token's storage directly.
        deal(c.token, buyer, 10e6);
        assertEq(IERC20(c.token).balanceOf(buyer), 10e6, "deal");

        bytes32 jobId = keccak256(abi.encode("fork-job", c.token));
        XorvEscrow.Funding memory f = _signedFunding(escrow, c.token, buyer, provider, jobId);
        vm.prank(attester);
        escrow.fund(f);
        assertEq(IERC20(c.token).balanceOf(address(escrow)), PRICE, "funded");

        vm.prank(attester);
        escrow.release(jobId, keccak256("result"));
        assertEq(IERC20(c.token).balanceOf(provider), PRICE, "released");
        assertEq(IERC20(c.token).balanceOf(buyer), 10e6 - PRICE, "buyer debited");
    }
}
