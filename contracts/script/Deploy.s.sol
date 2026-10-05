// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {XorvLog} from "../src/XorvLog.sol";
import {XorvRegistry} from "../src/XorvRegistry.sol";
import {XorvRefundKeeper} from "../src/XorvRefundKeeper.sol";
import {CleanverseGate} from "../src/CleanverseGate.sol";

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
 * XORV_CLEANVERSE=1 also deploys a CleanverseGate over Cleanverse's A-Pass and sets it as the
 * escrow's identity gate, so only CVI-verified buyers and providers can move money through it.
 * Monad testnet's A-Pass and validator are built in; XORV_CLEANVERSE_APASS / _VALIDATOR override
 * them, and XORV_CLEANVERSE_POOL adds the validator's complianceVerify once a pool is registered.
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

    function _cleanverse(uint256 chainId) internal view returns (address apass, address validator, address pool) {
        apass = vm.envOr("XORV_CLEANVERSE_APASS", chainId == 10143 ? 0xbA82D189540CaC9DC6FF46B6837CaC1BFdEC58B9 : address(0));
        validator = vm.envOr(
            "XORV_CLEANVERSE_VALIDATOR", chainId == 10143 ? 0xaC7e5179C2C7f03f209136886c172eb34F161792 : address(0)
        );
        pool = vm.envOr("XORV_CLEANVERSE_POOL", address(0));
        require(apass != address(0), "Deploy: XORV_CLEANVERSE=1 needs XORV_CLEANVERSE_APASS on this chain");
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
        CleanverseGate gate;
        if (vm.envOr("XORV_CLEANVERSE", false)) {
            (address apass, address validator, address pool) = _cleanverse(block.chainid);
            gate = new CleanverseGate(apass, validator, pool);
            escrow.setIdentityGate(address(gate));
        }
        vm.stopBroadcast();

        console2.log("chain id        ", block.chainid);
        console2.log("XorvRegistry    ", address(registry));
        console2.log("XorvEscrow      ", address(escrow));
        console2.log("XorvLog         ", address(log));
        console2.log("XorvRefundKeeper", address(keeper));
        console2.log("CRE forwarder   ", keeper.forwarder());
        if (address(gate) != address(0)) console2.log("CleanverseGate  ", address(gate));
        console2.log("owner/attester  ", operator);
    }
}
