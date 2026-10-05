# @xorv/protocol

Shared types, money math, chain plumbing and x402 wiring for [Xorv](https://github.com/nickthelegend/xorv-monad) —
a marketplace for idle AI subscription capacity, paid per job in AUSD (or USDC) over x402 on Monad,
through an on-chain escrow.

Used by `@xorv/cli`, `@xorv/mcp`, `xorv-agent` and the Xorv broker. You only need it directly if you
are building your own buyer, provider or broker against the Xorv protocol.

It ships as a workspace package of [xorv-monad](https://github.com/nickthelegend/xorv-monad); the
`@xorv/protocol` on npm is the earlier Hedera version. Depend on it from the workspace
(`"@xorv/protocol": "workspace:*"`).

## What is in it

| Area | Exports |
|---|---|
| Networks | `NETWORKS`, `networkInfo`, `chainIdFor`, `rpcUrl`, `stablecoins`, `primaryStablecoin`, `explorerTx`, `explorerAddress`: Monad testnet (`eip155:10143`), Monad mainnet (`eip155:143`) and a local Anvil node (`eip155:31337`) |
| Chain | `evmChain`, `readClient`, `writeClient`, `accountFor`, `parsePrivateKey`, `fetchBalances`, `stablecoinBalance`, `verifyStablecoinDomains` |
| Money | `parseUsd`, `formatUsd`, `formatGas`: every stablecoin amount is 6 decimals |
| x402 | `buildFacilitator`, payment options for `exact` (EIP-3009) and Xorv's `escrow` scheme |
| Escrow | `EscrowClientScheme`, `EscrowFacilitatorScheme`, `releaseEscrow`, `refundEscrow`, `readEscrowJob`, `readIdentityGate`, the `XorvEscrow` ABI |
| Registry | `readReputation`, `sponsorRegistration`, the `XorvRegistry` ABI |
| Operator signer | `signerFromEnv`, `operatorWallet`, `operatorPolicy` (Privy server wallet and policy) |
| Audit log | `readLog`, envelope types, the `XorvLog` ABI |
| Types | `Provider`, `Capability`, `Job`, `JobRequest`, `PaymentRecord`, `RegisterRequest`, wire messages |

```ts
import { networkInfo, primaryStablecoin, formatUsd } from "@xorv/protocol";

networkInfo("eip155:10143").name;          // "Monad Testnet"
primaryStablecoin("eip155:10143").symbol;  // "AUSD"
formatUsd(1_000);                          // "$0.0010"
```

`XORV_RPC_URL` overrides the RPC and `XORV_STABLECOIN` the token, read per call.

MIT
