// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {XorvLog} from "../src/XorvLog.sol";

/**
 * Deploy XorvEscrow and XorvLog to the chain behind --rpc-url.
 *
 * The stablecoin allowlist is chosen by chain id from the verified addresses
 * below. The Stylus registry is deployed separately (contracts/stylus/registry
 * /deploy.sh) and passed in as XORV_REGISTRY_ADDRESS; after this script, point
 * the registry at the new escrow with `setEscrow`.
 *
 *   XORV_OPERATOR_KEY=0x… XORV_REGISTRY_ADDRESS=0x… \
 *     forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast
 *
 * The operator key is owner and attester at first; in production the attester
 * is rotated to a separate hot key and ownership moved to a multisig.
 */
contract Deploy is Script {
    function _tokens(uint256 chainId) internal view returns (address[] memory tokens) {
        if (chainId == 421614) {
            // Arbitrum Sepolia: Paxos USDG, Circle USDC.
            tokens = new address[](2);
            tokens[0] = 0xFFC95faa3d63Cde504a05B567C600B78C0b41892;
            tokens[1] = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
        } else if (chainId == 46630) {
            // Robinhood Chain Testnet: Paxos USDG.
            tokens = new address[](1);
            tokens[0] = 0x7E955252E15c84f5768B83c41a71F9eba181802F;
        } else if (chainId == 42161) {
            // Arbitrum One: Paxos USDG, Circle USDC.
            tokens = new address[](2);
            tokens[0] = 0x004B506865409877C9fA29bfb1ebA929984B9bbC;
            tokens[1] = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
        } else if (chainId == 4663) {
            // Robinhood Chain: Paxos USDG.
            tokens = new address[](1);
            tokens[0] = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
        } else if (vm.envOr("XORV_STABLECOIN", address(0)) != address(0)) {
            // Any other chain (a local Nitro dev node): the test token named in the env.
            tokens = new address[](1);
            tokens[0] = vm.envAddress("XORV_STABLECOIN");
        } else {
            revert("Deploy: no stablecoins configured for this chain");
        }
    }

    function run() external returns (XorvEscrow escrow, XorvLog log) {
        uint256 key = vm.envUint("XORV_OPERATOR_KEY");
        address operator = vm.addr(key);
        address registry = vm.envOr("XORV_REGISTRY_ADDRESS", address(0));

        vm.startBroadcast(key);
        escrow = new XorvEscrow(operator, operator, registry, _tokens(block.chainid));
        log = new XorvLog();
        vm.stopBroadcast();

        console2.log("chain id        ", block.chainid);
        console2.log("XorvEscrow      ", address(escrow));
        console2.log("XorvLog         ", address(log));
        console2.log("owner/attester  ", operator);
        console2.log("registry        ", registry);
    }
}
