import type { Address } from "viem";

/**
 * The Monad deployments XorvLedger is wired to. The ERC-8004 registries are the canonical v2.0.0
 * singletons (vanity 0x8004… addresses, checked on-chain: getVersion() == "2.0.0" and the
 * Reputation registry's getIdentityRegistry() points at the Identity registry listed here).
 * They are constructor arguments and immutable in the ledger, so a wrong value here means a
 * redeploy: keep this table in sync with packages/protocol's chains.ts.
 */
export interface MonadDeployment {
  /** Hardhat network name, also the deployments/<name>.json file name. */
  network: "monadTestnet" | "monad";
  chainId: number;
  caip2: `eip155:${number}`;
  /** Public RPC; override with MONAD_TESTNET_RPC_URL / MONAD_RPC_URL. */
  rpcUrl: string;
  rpcUrlEnv: "MONAD_TESTNET_RPC_URL" | "MONAD_RPC_URL";
  identity: Address;
  reputation: Address;
  explorerUrl: string;
}

export const MONAD_DEPLOYMENTS: Record<MonadDeployment["network"], MonadDeployment> = {
  monadTestnet: {
    network: "monadTestnet",
    chainId: 10143,
    caip2: "eip155:10143",
    rpcUrl: "https://testnet-rpc.monad.xyz",
    rpcUrlEnv: "MONAD_TESTNET_RPC_URL",
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    explorerUrl: "https://testnet.monadvision.com",
  },
  monad: {
    network: "monad",
    chainId: 143,
    caip2: "eip155:143",
    rpcUrl: "https://rpc.monad.xyz",
    rpcUrlEnv: "MONAD_RPC_URL",
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    explorerUrl: "https://monadvision.com",
  },
};

export function monadDeploymentFor(networkName: string): MonadDeployment | undefined {
  return (MONAD_DEPLOYMENTS as Record<string, MonadDeployment | undefined>)[networkName];
}

/**
 * The Monad network a chain id belongs to. A local fork of Monad testnet (`hardhat node --network
 * monadFork`, which the e2e harness runs) reports chain id 10143 under a network name that is not in
 * the table, and still carries the canonical registries at their real addresses.
 */
export function monadDeploymentForChainId(chainId: number): MonadDeployment | undefined {
  return Object.values(MONAD_DEPLOYMENTS).find((deployment) => deployment.chainId === chainId);
}

/** Where the e2e harness serves its Monad testnet fork unless MONAD_FORK_RPC_URL says otherwise. */
export const DEFAULT_FORK_RPC_URL = "http://127.0.0.1:8545";

/** The RPC URL for a Monad network, honouring its override variable (read per call). */
export function rpcUrlFor(deployment: MonadDeployment): string {
  return process.env[deployment.rpcUrlEnv] || deployment.rpcUrl;
}

/**
 * Monad bills the gas LIMIT a transaction asks for, not the gas it uses, so limits come from
 * eth_estimateGas plus a small margin (never a padded constant). 15% covers the drift between
 * estimate and execution without paying for headroom nobody uses.
 */
export function withGasMargin(estimate: bigint): bigint {
  return (estimate * 115n) / 100n;
}

/** What scripts/deploy.ts writes to deployments/<network>.json, and scripts/verify.ts reads back. */
export interface DeploymentRecord {
  contract: "XorvLedger";
  network: string;
  chainId: number;
  address: Address;
  txHash: `0x${string}`;
  blockNumber: number;
  identity: Address;
  reputation: Address;
  /** The broker and owner the ledger was constructed with (scripts/verify.ts passes both back as
   *  constructor arguments), not whoever holds the roles after a later setBroker/transferOwnership. */
  broker: Address;
  owner: Address;
  deployedAt: string;
}
