# @xorv/mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent **buy AI work from the Xorv network and pay for it itself**. It pays per job in USDC over [x402](https://x402.org) on **Monad**, from either a local key or a **Privy server wallet bound to a signing policy**.

The agent asks for a quote, the network matches a provider (someone renting out an idle Claude Code, Codex, Qwen, Kimi or Hunyuan subscription), the agent signs a USDC authorization for exactly that quote, the network's facilitator settles it on-chain and pays the gas, and the job runs on the provider's machine. No human opens a browser, creates an account or types in a card number. The provider is paid directly; the Xorv broker never holds the money.

```
agent ──xorv_run_job──► MCP server ──POST /api/quotes──► broker: frozen quote (provider 0x…, price, USDC units)
                           │  checks the quote against XORV_MAX_PRICE and the session budget
                           ├──POST /api/jobs/:quoteId──► 402 { exact, eip155:10143, USDC, amount, payTo: provider }
                           │  signs EIP-3009 TransferWithAuthorization (local key, or Privy under its policy)
                           ├──PAYMENT-SIGNATURE──► facilitator: transferWithAuthorization payer → provider (pays MON gas)
                           └──polls──► result + Monadscan links (payment tx, XorvLedger receipt)
```

## Tools

| Tool | What it does | Needs a payer |
|---|---|---|
| `xorv_list_providers` | Lists live providers, what they run, their price per job, their payout address and their ERC-8004 identity. | no |
| `xorv_network_status` | Shows the network, USDC contract, facilitator, XorvLedger audit contract, ERC-8004 registries, the AI roles (router, safety screen, verifier) and totals. | no |
| `xorv_quote` | Prices a job without paying. | no |
| `xorv_get_job` | Looks up a job: status, result, payment tx, XorvLedger receipt, verifier score and rating. | no |
| `xorv_wallet` | Shows which wallet pays (local key or Privy), its address, its USDC balance, the per-job cap and how much session budget is left. It spends nothing. | yes |
| `xorv_run_job` | **Spends money.** Quotes, pays over x402, waits, and returns the result with explorer links proving payment. | yes |
| `xorv_rate_job` | Signs an EIP-712 rating (0–100) for a job you paid for. The broker relays it at no cost to you, and it becomes ERC-8004 reputation for the provider. | yes |

The `xorv_run_job` description states the per-job cap and the session budget, because a model decides whether to call a tool from its description alone. Tools also carry MCP annotations (`destructiveHint` on `xorv_run_job`, `readOnlyHint` on reads) so clients can ask for confirmation.

## Quick start

You need a broker URL. It defaults to a local one at `http://localhost:8402`; run one with `pnpm broker` from the repo root. You also need a payer that holds **test USDC on Monad testnet**. It needs no MON, because the facilitator pays gas.

> **Install from source until 0.2.0 is on npm.** What npm serves as `@xorv/mcp` today is 0.1.0, the
> Hedera prototype: it pays on Hedera and cannot buy from a Monad broker. `npx -y @xorv/mcp` resolves
> to it. Build this package from the repository instead:
>
> ```sh
> git clone https://github.com/nickthelegend/xorv-monad.git && cd xorv-monad
> pnpm install
> pnpm --filter @xorv/protocol build && pnpm --filter @xorv/mcp build
> ```
>
> Every example below then runs `node /path/to/xorv-monad/packages/mcp/dist/index.js`. Once 0.2.0 is
> published, `npx -y @xorv/mcp@0.2.0` (pinned, so it can never fall back to 0.1.0) replaces that
> command.

### Claude Code

```sh
# local key
claude mcp add xorv \
  -e XORV_BROKER_URL=http://localhost:8402 \
  -e XORV_PRIVATE_KEY=0xYOUR_TESTNET_KEY \
  -- node /path/to/xorv-monad/packages/mcp/dist/index.js

# or: a Privy server wallet (see "Privy agentic wallet" below)
claude mcp add xorv \
  -e XORV_BROKER_URL=http://localhost:8402 \
  -e XORV_PRIVY_APP_ID=... -e XORV_PRIVY_APP_SECRET=... -e XORV_PRIVY_WALLET_ID=... \
  -- node /path/to/xorv-monad/packages/mcp/dist/index.js
```

For a project-scoped setup, put the same thing in `.mcp.json`:

```json
{
  "mcpServers": {
    "xorv": {
      "command": "node",
      "args": ["/path/to/xorv-monad/packages/mcp/dist/index.js"],
      "env": {
        "XORV_BROKER_URL": "http://localhost:8402",
        "XORV_NETWORK": "eip155:10143",
        "XORV_PRIVY_APP_ID": "…",
        "XORV_PRIVY_APP_SECRET": "…",
        "XORV_PRIVY_WALLET_ID": "…",
        "XORV_MAX_PRICE": "0.05",
        "XORV_SESSION_BUDGET_USD": "0.50"
      }
    }
  }
}
```

### Claude Desktop

In `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "xorv": {
      "command": "node",
      "args": ["/path/to/xorv-monad/packages/mcp/dist/index.js"],
      "env": {
        "XORV_BROKER_URL": "https://your-broker.example",
        "XORV_PRIVATE_KEY": "0xYOUR_TESTNET_KEY",
        "XORV_MAX_PRICE": "0.05"
      }
    }
  }
}
```

On Windows, give the path with forward slashes or escaped backslashes (`"C:/src/xorv-monad/packages/mcp/dist/index.js"`). If Claude Desktop cannot find `node`, put the full path to `node.exe` in `"command"`. After 0.2.0 is published, `"command": "npx"` with `"args": ["-y", "@xorv/mcp@0.2.0"]` works too (on Windows, `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@xorv/mcp@0.2.0"]`).

Then ask for something like: *"Use xorv to get a second opinion on this function from another model, and don't spend more than 2 cents."*

## Environment

All configuration comes from the environment. The server is launched by another program and has no terminal to prompt at. A bad value never crashes the server at launch. Instead, every tool answers with what is wrong and how to fix it.

| Variable | Default | Meaning |
|---|---|---|
| `XORV_BROKER_URL` | `http://localhost:8402` | The broker to buy from. |
| `XORV_NETWORK` | `eip155:10143` | Monad testnet, or `eip155:143` for mainnet. Anything else, including a leftover `hedera:testnet`, is refused. |
| `XORV_MAX_PRICE` | `0.05` | Hard ceiling **per job**, in USD. The model can ask for less, never more. `XORV_MAX_USD` (the 0.1 name) is still honoured. |
| `XORV_SESSION_BUDGET_USD` | `0.50` | Hard ceiling **per server process** across all jobs. `unlimited` turns it off. Restarting the server resets it. |
| `XORV_PRIVATE_KEY` | — | Local-key mode: a 0x-prefixed 32-byte secp256k1 key. `XORV_PAYER_KEY` (the CLI's name) also works. |
| `XORV_PRIVY_APP_ID`, `XORV_PRIVY_APP_SECRET`, `XORV_PRIVY_WALLET_ID` | — | Privy mode: the app's credentials and the server wallet to pay from. |
| `XORV_PRIVY_AUTH_KEY` | — | Privy mode, owner-keyed wallets only: the base64 PKCS#8 P-256 authorization key. A `wallet-auth:` prefix is accepted. |
| `XORV_SIGNER` | — | `local` or `privy`. Only needed when both are configured; the server will not guess which one should pay. |
| `XORV_RPC_URL`, `XORV_EXPLORER_URL`, `XORV_STABLECOIN` | network defaults | Overrides read by `@xorv/protocol`: a private RPC for `xorv_wallet`'s balance read, a different explorer for links, and a different stablecoin. |

With no payer configured, the read-only tools work. `xorv_run_job`, `xorv_rate_job` and `xorv_wallet` then explain how to add a payer.

## Privy agentic wallet

The problem with giving a model a spending tool is that its limits are usually promises made by the same process the model drives. Privy mode moves the key, and the rule about what it may sign, out of that process:

- The wallet is a **Privy server wallet**. Its key never exists on this machine. Privy signs inside its enclave, and only when the request passes the **policy** attached to the wallet.
- `pnpm privy:setup` writes that policy to allow **only** `eth_signTypedData_v4` for USDC `TransferWithAuthorization` on this chain, with `value ≤ your cap`. It also allows ratings on XorvLedger when you pass `--ledger` or `--broker`. A request that matches no rule is denied, so the wallet cannot send transactions, sign other tokens, sign on other chains, or sign one payment above the cap. That holds even if the MCP host is compromised.
- The server wraps the wallet with Privy's `createViemAccount` (from `@privy-io/node/viem`). x402's `ExactEvmScheme` signs through it like any viem account. It is built **once per process**: one client, one wallet lookup, then reused.

### Set it up

1. Create an app at [dashboard.privy.io](https://dashboard.privy.io) and copy its **App ID** and **App secret**.
2. Create the policy and the wallet:

   ```sh
   export XORV_PRIVY_APP_ID=... XORV_PRIVY_APP_SECRET=...
   pnpm --filter @xorv/mcp privy:setup -- --cap-usdc 0.05 --broker http://localhost:8402
   ```

   Options:
   - `--network eip155:143`: use mainnet.
   - `--ledger 0x…`: give the XorvLedger address directly instead of reading it from the broker.
   - `--pay-to 0xA,0xB`: only allow paying these providers.
   - `--owner-key`: also generate a P-256 owner key for the wallet and the policy. Then the app secret alone can neither sign nor loosen the policy, and the MCP server needs `XORV_PRIVY_AUTH_KEY`.
   - `--dry-run`: print the policy JSON without calling Privy.

   The script is also published as the `xorv-mcp-privy-setup` bin. It prints the `XORV_PRIVY_*` lines for your MCP config and the wallet address.
3. Fund the address with test USDC at [faucet.circle.com](https://faucet.circle.com) by choosing **Monad Testnet**. No MON is needed.
4. Add the printed variables to the MCP server's `env` and call `xorv_wallet` to check the setup. Its first line names the Privy wallet id, its address and the attached policy id (`Payer: Privy server wallet <id> 0x… (policy <policy id>)`), and says `NO POLICY attached` in capitals if the wallet has none. A signature Privy refuses under the policy ends the call with `Payment not made: …` and releases the session-budget reservation, because nothing was signed.

### What the policy does not do

Privy's typed-data policies cap **each signature**. Privy's rolling-window spend limits (aggregations) apply to transaction signing, not to EIP-712 typed data, and an x402 payment is typed data. The policy alone therefore cannot stop a model from collecting one in-policy signature after another. The cumulative bound is enforced by this server:

1. **`XORV_MAX_PRICE`** caps each job. It is enforced on the quote request, again on the returned quote, and as x402's per-payment spend control.
2. **`XORV_SESSION_BUDGET_USD`** caps the total per server process. The price is reserved before anything is signed, so two parallel calls cannot both fit into the same remaining headroom. It is released only when no money can have moved. If a payment was signed and the outcome is unclear, it counts as spent.
3. The **Privy policy** caps each signature at the Privy side. This limit still holds if steps 1 and 2 are bypassed.

Set the policy cap to the same value as `XORV_MAX_PRICE`. The setup script prints it.

## Payment safety

A signed EIP-3009 authorization can be spent by whoever holds it, so every check happens **before** signing:

- The quote must be on the server's network, under every ceiling, and freeze a USDC amount equal to its advertised price. It must also pay a provider address that is not the payer's own.
- The 402 must then ask for **exactly** that frozen quote: same payee, same amount, same USDC contract, same chain. This is `@xorv/protocol`'s `buyerX402Client` with the quote as `expect`. If a broker swaps the payee or raises the price between quote and payment, the server returns an error and signs nothing.
- The server pays at the broker it is configured for, not at the `payUrl` the quote reports.
- Ratings get the same treatment. `xorv_rate_job` signs only a XorvLedger `Rating` on this chain, for this job id and the score you asked for, and only when the broker agrees that this wallet paid for the job.

## Development

```sh
pnpm install
pnpm --filter @xorv/protocol build   # the MCP server imports @xorv/protocol from dist
pnpm --filter @xorv/mcp typecheck
pnpm --filter @xorv/mcp test         # offline: mock broker, fake Privy client, no chain
pnpm --filter @xorv/mcp build
pnpm --filter @xorv/mcp dev          # run from source with tsx
```

The tests run the real server over stdio against a local mock broker. The mock verifies the x402 payment and rating signatures, so a passing run has produced signatures the real facilitator and XorvLedger would accept. They also cover signer-mode selection with a fake Privy client driving Privy's real `createViemAccount`, the quote policy, the session budget and the setup script's policy. No test needs credentials or network, and nothing in them is platform-specific (they are developed on Windows).

Source map:

| File | What it holds |
|---|---|
| `src/index.ts` | stdio entry |
| `src/server.ts` | the tools |
| `src/config.ts` | env parsing |
| `src/signer.ts` | local / Privy signer selection and the Privy account |
| `src/buy.ts` | quote vetting, x402 payment, polling |
| `src/rate.ts` | rating checks and signing |
| `src/budget.ts` | session budget |
| `src/privy-policy.ts` | the Privy policy |
| `src/scripts/privy-setup.ts` | the setup script |

### Upgrading from 0.1 (Hedera)

- `XORV_PAYER_ID` is gone. On Monad the address is derived from the key.
- `XORV_PAYER_KEY` must now be a raw 0x secp256k1 key. Hedera ED25519 keys cannot be reused, and the server says so.
- `XORV_NETWORK` is `eip155:10143` or `eip155:143`.
- `XORV_MAX_USD` is now `XORV_MAX_PRICE`. The old name still works.
- `xorv_run_job` no longer takes `pay_with`. x402 `exact` on EVM moves ERC-20s only, so every job is paid in USDC.
- HashScan links are replaced by Monadscan links, and 0.0.x account ids by 0x addresses.

## License

MIT
