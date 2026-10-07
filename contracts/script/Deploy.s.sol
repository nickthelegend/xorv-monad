// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {XorvEscrow} from "../src/XorvEscrow.sol";
import {XorvRefundKeeper} from "../src/XorvRefundKeeper.sol";
import {CleanverseGate} from "../src/CleanverseGate.sol";

/**
 * Deploy XorvEscrow and XorvRefundKeeper (and, with XORV_CLEANVERSE=1, a CleanverseGate set on the
 * escrow) to the chain behind --rpc-url.
 *
 *   XORV_OPERATOR_KEY=0x… forge script script/Deploy.s.sol \
 *     --rpc-url https://testnet-rpc.monad.xyz --broadcast --verify --verifier sourcify \
 *     --verifier-url https://sourcify-api-monad.blockvision.org
 *
 * Roles. The operator key deploys and owns both contracts. The escrow's attester (who funds,
 * releases and refunds jobs) is the broker's settlement key: XORV_FACILITATOR_KEY's address when
 * that is set, the operator otherwise. Reputation is not the escrow's job in this repo: XorvLedger
 * writes it to ERC-8004, so the escrow's registry hook is left unset.
 *
 * Turn the Cleanverse gate on only once Cleanverse has issued A-Passes to the parties who will
 * transact (docs/DEPLOY-LATER.md); with it on, nobody without one can fund or be paid.
 */
contract Deploy is Script {
    function _tokens(uint256 chainId) internal view returns (address[] memory tokens) {
        if (chainId == 10143) {
            // Monad testnet: Circle test USDC, Agora AUSD.
            tokens = new address[](2);
            tokens[0] = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
            tokens[1] = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
        } else if (chainId == 143) {
            // Monad mainnet: Circle USDC, Agora AUSD.
            tokens = new address[](2);
            tokens[0] = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
            tokens[1] = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
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

    function run() external returns (XorvEscrow escrow, XorvRefundKeeper keeper, CleanverseGate gate) {
        uint256 key = vm.envUint("XORV_OPERATOR_KEY");
        address operator = vm.addr(key);
        uint256 settlementKey = vm.envOr("XORV_FACILITATOR_KEY", uint256(0));
        address attester = settlementKey == 0 ? operator : vm.addr(settlementKey);

        vm.startBroadcast(key);
        escrow = new XorvEscrow(operator, attester, address(0), _tokens(block.chainid));
        keeper = new XorvRefundKeeper(address(escrow), _forwarder(block.chainid, operator), operator);
        if (vm.envOr("XORV_CLEANVERSE", false)) {
            (address apass, address validator, address pool) = _cleanverse(block.chainid);
            gate = new CleanverseGate(apass, validator, pool);
            escrow.setIdentityGate(address(gate));
        }
        vm.stopBroadcast();

        console2.log("chain id        ", block.chainid);
        console2.log("XorvEscrow      ", address(escrow));
        console2.log("XorvRefundKeeper", address(keeper));
        console2.log("CRE forwarder   ", keeper.forwarder());
        if (address(gate) != address(0)) console2.log("CleanverseGate  ", address(gate));
        console2.log("owner           ", operator);
        console2.log("attester        ", attester);
    }
}
