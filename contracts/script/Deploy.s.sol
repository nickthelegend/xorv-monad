// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {XorvLog} from "../src/XorvLog.sol";
import {XorvRegistry} from "../src/XorvRegistry.sol";
import {XorvRefundKeeper} from "../src/XorvRefundKeeper.sol";

/**
 * Deploy XorvRegistry, XorvEscrow, XorvLog and XorvRefundKeeper to the chain behind --rpc-url,
 * and wire them:
 * the registry accepts outcomes only from the new escrow, and the operator may register and
 * heartbeat providers on their behalf.
 *
 *   XORV_OPERATOR_KEY=0x… forge script script/Deploy.s.sol \
 *     --rpc-url monad_testnet --broadcast --verify --verifier sourcify \
 *     --verifier-url https://sourcify-api-monad.blockvision.org
 *
 * The operator key is owner, attester and registry operator at first; in production the
 * attester moves to a separate hot key and ownership to a multisig.
 */
contract Deploy is Script {
    function _tokens(uint256 chainId) internal view returns (address[] memory tokens) {
        if (chainId == 10143) {
            // Monad testnet: Agora AUSD, Circle test USDC.
            tokens = new address[](2);
            tokens[0] = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
            tokens[1] = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
        } else if (chainId == 143) {
            // Monad mainnet: Agora AUSD, Circle USDC.
            tokens = new address[](2);
            tokens[0] = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
            tokens[1] = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
        } else if (vm.envOr("XORV_STABLECOIN", address(0)) != address(0)) {
            // Any other chain (a local dev node): the test token named in the env.
            tokens = new address[](1);
            tokens[0] = vm.envAddress("XORV_STABLECOIN");
        } else {
            revert("Deploy: no stablecoins configured for this chain");
        }
    }

    /// The Chainlink KeystoneForwarder the refund keeper trusts. Defaults to Monad testnet's
    /// MockKeystoneForwarder, which `cre workflow simulate --broadcast` delivers through;
    /// XORV_CRE_FORWARDER picks another (the production forwarder once the workflow is deployed).
    function _forwarder(uint256 chainId, address fallback_) internal view returns (address) {
        address configured = vm.envOr("XORV_CRE_FORWARDER", address(0));
        if (configured != address(0)) return configured;
        if (chainId == 10143) return 0xB9F79d863261869B234c481D1f9A7af84AeAd192;
        if (chainId == 143) return 0x9eF6468C5f37b976E57d52054c693269479A784d;
        return fallback_;
    }

    function run()
        external
        returns (XorvRegistry registry, XorvEscrow escrow, XorvLog log, XorvRefundKeeper keeper)
    {
        uint256 key = vm.envUint("XORV_OPERATOR_KEY");
        address operator = vm.addr(key);

        vm.startBroadcast(key);
        registry = new XorvRegistry(operator);
        escrow = new XorvEscrow(operator, operator, address(registry), _tokens(block.chainid));
        log = new XorvLog();
        registry.setEscrow(address(escrow));
        registry.setOperator(operator);
        keeper = new XorvRefundKeeper(address(escrow), _forwarder(block.chainid, operator), operator);
        vm.stopBroadcast();

        console2.log("chain id        ", block.chainid);
        console2.log("XorvRegistry    ", address(registry));
        console2.log("XorvEscrow      ", address(escrow));
        console2.log("XorvLog         ", address(log));
        console2.log("XorvRefundKeeper", address(keeper));
        console2.log("CRE forwarder   ", keeper.forwarder());
        console2.log("owner/attester  ", operator);
    }
}
