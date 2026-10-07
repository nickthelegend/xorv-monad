// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";

interface IAgoraFaucet {
    function requestFunds(address to) external;
}

interface IDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/**
 * The escrow against the *real* stablecoins, on a fork of Monad testnet.
 *
 * The mock proves the logic; this proves the integration. Agora's AUSD signs EIP-3009
 * under the domain "Agora Dollar" v1 (not its `name()`, "AUSD"), and Circle's test USDC
 * under "USDC" v2, so the one way to be sure a buyer's signature lands is to sign exactly
 * as a wallet would, against the token's own DOMAIN_SEPARATOR, and let the token decide.
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
    address internal constant AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    address internal constant AGORA_FAUCET = 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C;

    struct Case {
        string rpc;
        address token;
        string name;
        string version;
    }

    function _cases() internal pure returns (Case[2] memory) {
        return [
            Case("monad_testnet", 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC, "Agora Dollar", "1"),
            Case("monad_testnet", 0x534b2f3A21130d7a60830c2Df862319e593943A3, "USDC", "2")
        ];
    }

    function _enabled() internal view returns (bool) {
        return vm.envOr("FORK_TESTS", false);
    }

    function test_fork_domainsMatchConfiguredValues() public {
        if (!_enabled()) return;
        Case[2] memory cases = _cases();
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
        Case[2] memory cases = _cases();
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
        // No registry: in this repo, reputation is ERC-8004's (XorvLedger), not the escrow's.
        XorvEscrow escrow = new XorvEscrow(address(this), attester, address(0), tokens);

        // Give the buyer a balance. AUSD packs balances in a way `deal` can't write, so take it
        // from Agora's own testnet faucet (10,000 AUSD) and keep 10.
        if (c.token == AUSD) {
            vm.warp(block.timestamp + 61); // the faucet has a 60 s global cooldown
            IAgoraFaucet(AGORA_FAUCET).requestFunds(buyer);
            uint256 extra = IERC20(c.token).balanceOf(buyer) - 10e6; // read before the prank
            vm.prank(buyer);
            IERC20(c.token).transfer(address(0xdead), extra);
        } else {
            deal(c.token, buyer, 10e6);
        }
        assertEq(IERC20(c.token).balanceOf(buyer), 10e6, "funded buyer");

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
