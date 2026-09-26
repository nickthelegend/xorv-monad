import type { HardhatViemHelpers } from "@nomicfoundation/hardhat-viem/types";
import { type Address, encodeFunctionData, parseAbi, zeroAddress } from "viem";

const MINIMAL_UUPS_ABI = parseAbi([
  "function initialize(address identityRegistry_)",
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
]);
const IDENTITY_INIT_ABI = parseAbi(["function initialize()"]);

/**
 * Deploys the real ERC-8004 v2.0.0 registries the way upstream's own tests (and the Monad vanity
 * deployment) do it: an ERC1967 proxy is created over a minimal UUPS placeholder that records the
 * owner, then upgraded to the real implementation with its reinitializer(2) `initialize`. The
 * implementations disable initializers in their constructors, so this is the only way to get a
 * working instance.
 */
export async function deployErc8004(viem: HardhatViemHelpers) {
  async function proxied(identityRegistry: Address, implementation: "IdentityRegistryUpgradeable" | "ReputationRegistryUpgradeable") {
    const placeholder = await viem.deployContract("HardhatMinimalUUPS");
    const proxy = await viem.deployContract("ERC1967Proxy", [
      placeholder.address,
      encodeFunctionData({ abi: MINIMAL_UUPS_ABI, functionName: "initialize", args: [identityRegistry] }),
    ]);
    const impl = await viem.deployContract(implementation);
    const init =
      implementation === "IdentityRegistryUpgradeable"
        ? encodeFunctionData({ abi: IDENTITY_INIT_ABI, functionName: "initialize" })
        : encodeFunctionData({ abi: MINIMAL_UUPS_ABI, functionName: "initialize", args: [identityRegistry] });
    const asPlaceholder = await viem.getContractAt("HardhatMinimalUUPS", proxy.address);
    await asPlaceholder.write.upgradeToAndCall([impl.address, init]);
    return proxy.address;
  }

  const identityAddress = await proxied(zeroAddress, "IdentityRegistryUpgradeable");
  const reputationAddress = await proxied(identityAddress, "ReputationRegistryUpgradeable");
  const identity = await viem.getContractAt("IdentityRegistryUpgradeable", identityAddress);
  const reputation = await viem.getContractAt("ReputationRegistryUpgradeable", reputationAddress);
  return { identity, reputation };
}
