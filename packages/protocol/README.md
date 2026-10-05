# @xorv/protocol

Shared types, money math, chain plumbing and x402 wiring for [Xorv](https://github.com/nickthelegend/xorv-monad) —
a marketplace for idle AI subscription capacity, paid per job in USDC over x402 on Arc.

Used by `@xorv/cli`, `@xorv/mcp` and the Xorv broker. You only need it directly if you are building your
own buyer, provider or broker against the Xorv protocol.

It ships as a workspace package of [xorv-monad](https://github.com/nickthelegend/xorv-monad) —
the `@xorv/protocol` on npm is the earlier Hedera version. Depend on it from the workspace
(`"@xorv/protocol": "workspace:*"`).

## What is in it

| Area | Exports |
|---|---|
| Networks | `NETWORKS`, `networkInfo`, `isWorldChain`, `rpcUrl`, `usdcAddress`, `explorerTx`, `explorerAddress` — Arc testnet/mainnet (`eip155:5042002` / `eip155:5042`) and World Chain Sepolia/mainnet (`eip155:4801` / `eip155:480`) |
| Chain | `arcChain`, `readClient`, `writeClient`, `accountFor`, `parsePrivateKey`, `fetchBalances`, `usdcBalance`, `usdcDomain` |
| Money | `parseUsd`, `formatUsd`, `usdMicrosToUsdcUnits`, `usdcUnitsToUsdMicros` — every amount is USDC's 6 decimals |
| x402 | `buildFacilitator`, payment option helpers for the stock EVM `exact` scheme over EIP-3009 |
| Audit log | `readLog`, envelope types, the `XorvLog` ABI |
| Types | `Provider`, `Capability`, `Job`, `JobRequest`, `PaymentRecord`, `RegisterRequest`, wire messages |

```ts
import { networkInfo, usdcAddress, formatUsd } from "@xorv/protocol";

networkInfo("eip155:5042002").name; // "Arc Testnet"
usdcAddress("eip155:4801");         // World Chain Sepolia USDC
formatUsd(1_000);                   // "$0.0010"
```

`XORV_RPC_URL` overrides the RPC and `XORV_STABLECOIN` the token, read per call.

MIT
