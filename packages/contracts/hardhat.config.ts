import { fileURLToPath } from "node:url";

import hardhatKeystore from "@nomicfoundation/hardhat-keystore";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";
import { configVariable, defineConfig } from "hardhat/config";

import { DEFAULT_FORK_RPC_URL, MONAD_DEPLOYMENTS, rpcUrlFor } from "./scripts/lib/networks.js";

// The broker's settings live in the repo-root .env, so the deployer can reuse XORV_OPERATOR_KEY and
// XORV_BROKER_ADDRESS from there. A package-local .env is read first and wins; real environment
// variables beat both (process.loadEnvFile never overwrites a variable that is already set).
for (const file of ["./.env", "../../.env"]) {
  try {
    process.loadEnvFile(fileURLToPath(new URL(file, import.meta.url)));
  } catch {
    // No such file: nothing to load.
  }
}

// Keys are never in this file. They're Hardhat configuration variables, resolved only when a live
// network is actually used (tests never touch them), from the environment or the encrypted Hardhat
// keystore (`pnpm hardhat keystore set XORV_DEPLOYER_KEY`). A dedicated deployer key is preferred;
// when only the broker's XORV_OPERATOR_KEY is present in the environment, that one deploys.
const deployerKey = configVariable(
  !process.env.XORV_DEPLOYER_KEY && process.env.XORV_OPERATOR_KEY ? "XORV_OPERATOR_KEY" : "XORV_DEPLOYER_KEY",
);

// Monadscan is run by Etherscan, so one Etherscan V2 key (chainid 10143 / 143) covers it. Without a
// key, Etherscan verification is switched off and Sourcify (MonadVision) alone is used.
const explorerKeyName = process.env.MONADSCAN_API_KEY ? "MONADSCAN_API_KEY" : "ETHERSCAN_API_KEY";
const hasExplorerKey = Boolean(process.env.MONADSCAN_API_KEY || process.env.ETHERSCAN_API_KEY);

// XorvLedger: 0.8.24 / cancun / optimizer 200, the settings the protocol ABI and the gas figures in
// the README are measured with. Monad executes every cancun opcode (MCOPY, TSTORE, PUSH0 were probed
// on both chains), which OpenZeppelin 5.x needs. The Monad docs recommend "osaka" for new projects;
// cancun output is a strict subset of it, and staying on 0.8.24 matches the ERC-8004 registries.
const LEDGER_COMPILER = {
  version: "0.8.24",
  settings: {
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 },
  },
};

// The vendored ERC-8004 registries are compiled the way upstream builds them (viaIR, which their
// larger functions need to avoid stack-too-deep). They exist only for local tests.
const VENDOR_COMPILER = {
  version: "0.8.24",
  settings: {
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
  },
};

const VENDORED = [
  "contracts/vendor/erc8004/IdentityRegistryUpgradeable.sol",
  "contracts/vendor/erc8004/ReputationRegistryUpgradeable.sol",
  "contracts/vendor/erc8004/HardhatMinimalUUPS.sol",
  "contracts/vendor/erc8004/ERC1967Proxy.sol",
];

// `build`, `run` and `test` use the "default" profile while `verify` uses "production". Both are
// identical here so the bytecode that gets deployed is byte-for-byte what gets verified.
const buildProfile = {
  compilers: [LEDGER_COMPILER],
  overrides: Object.fromEntries(VENDORED.map((file) => [file, VENDOR_COMPILER])),
};

// The e2e harness (e2e/) forks Monad testnet so the real Circle USDC and the canonical ERC-8004
// registries are present. MONAD_FORK_BLOCK pins the fork for reproducible runs; unset forks the
// latest block. Nothing here touches the network until `hardhat node --network monadFork` runs.
const forkBlock = process.env.MONAD_FORK_BLOCK?.trim();

// Monad executes Prague (its blocks carry requestsHash, and EIP-7702 is live), so the fork mines
// Prague blocks, and EDR is told the same for blocks it only replays from the remote chain. Without
// a hardfork history for chain 10143, EDR refuses every call against the fork block itself ("No known
// hardfork for execution on historical block").
const MONAD_HARDFORK = "prague";
const MONAD_HARDFORK_HISTORY = { [MONAD_HARDFORK]: { blockNumber: 0 } };

export default defineConfig({
  plugins: [
    hardhatViem,
    hardhatViemAssertions,
    hardhatNodeTestRunner,
    hardhatNetworkHelpers,
    hardhatKeystore,
    hardhatVerify,
  ],
  solidity: {
    profiles: {
      default: buildProfile,
      production: buildProfile,
    },
  },
  networks: {
    monadTestnet: {
      type: "http",
      chainType: "l1",
      chainId: MONAD_DEPLOYMENTS.monadTestnet.chainId,
      url: rpcUrlFor(MONAD_DEPLOYMENTS.monadTestnet),
      accounts: [deployerKey],
    },
    monad: {
      type: "http",
      chainType: "l1",
      chainId: MONAD_DEPLOYMENTS.monad.chainId,
      url: rpcUrlFor(MONAD_DEPLOYMENTS.monad),
      accounts: [deployerKey],
    },
    // A local fork of Monad testnet, served over JSON-RPC by `hardhat node --network monadFork`.
    // Its dev accounts are Hardhat's well-known ones: never point anything real at it.
    monadFork: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: MONAD_DEPLOYMENTS.monadTestnet.chainId,
      hardfork: MONAD_HARDFORK,
      forking: {
        url: process.env.MONAD_FORK_URL?.trim() || rpcUrlFor(MONAD_DEPLOYMENTS.monadTestnet),
        ...(forkBlock ? { blockNumber: Number(forkBlock) } : {}),
      },
    },
    // That fork as another process sees it (`hardhat run scripts/deploy.ts --network monadForkRpc`),
    // signing with the node's unlocked dev accounts.
    monadForkRpc: {
      type: "http",
      chainType: "l1",
      chainId: MONAD_DEPLOYMENTS.monadTestnet.chainId,
      url: process.env.MONAD_FORK_RPC_URL?.trim() || DEFAULT_FORK_RPC_URL,
      accounts: "remote",
    },
  },
  verify: {
    etherscan: {
      enabled: hasExplorerKey,
      apiKey: configVariable(explorerKeyName),
    },
    sourcify: {
      enabled: true,
      apiUrl: "https://sourcify-api-monad.blockvision.org",
    },
    blockscout: {
      enabled: false,
    },
  },
  chainDescriptors: {
    10143: {
      name: "Monad Testnet",
      // Hardhat hands a descriptor's hardfork history to EDR only when the descriptor's chain type
      // is the forking network's; a chain it has no default for is "generic", which an l1 fork skips.
      chainType: "l1",
      hardforkHistory: MONAD_HARDFORK_HISTORY,
      blockExplorers: {
        etherscan: {
          name: "Monadscan",
          url: "https://testnet.monadscan.com",
          apiUrl: "https://api.etherscan.io/v2/api",
        },
      },
    },
    143: {
      name: "Monad",
      blockExplorers: {
        etherscan: {
          name: "Monadscan",
          url: "https://monadscan.com",
          apiUrl: "https://api.etherscan.io/v2/api",
        },
      },
    },
  },
});
