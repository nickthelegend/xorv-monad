import { fileURLToPath } from "node:url";

import hardhatKeystore from "@nomicfoundation/hardhat-keystore";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";
import { configVariable, defineConfig } from "hardhat/config";

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
      chainId: 10143,
      url: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
      accounts: [deployerKey],
    },
    monad: {
      type: "http",
      chainType: "l1",
      chainId: 143,
      url: process.env.MONAD_RPC_URL || "https://rpc.monad.xyz",
      accounts: [deployerKey],
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
