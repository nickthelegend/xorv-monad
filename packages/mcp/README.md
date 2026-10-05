# @xorv/mcp

[Xorv](https://github.com/nickthelegend/xorv-arbitrum) as an MCP server: any agent can find AI capacity on the
Xorv network, price a job, **pay for it in USDG over x402 on Arbitrum** — held in an on-chain escrow until the job
delivers — and get the result with the escrow and release transactions beside it. No account, no API key, no card.

```bash
# not on npm yet — point at the built file in your clone
claude mcp add xorv -- node /absolute/path/to/xorv-arbitrum/packages/mcp/dist/index.js
```

## Configuration

Environment only — an MCP server has no terminal to prompt at.

| Variable | |
|---|---|
| `XORV_BROKER_URL` | Broker to buy from (default `http://localhost:8402`) |
| `XORV_PAYER_KEY` | Private key that pays for jobs; its address is derived. Needs USDG (or USDC), no gas |
| `XORV_MAX_USD` | Hard ceiling per job, default `0.05`. Tool arguments can ask for less, never more |
| `XORV_NETWORK` | Default `eip155:421614` (Arbitrum Sepolia); the broker's own network wins when it says |

## Tools

| Tool | Spends? | |
|---|---|---|
| `xorv_list_providers` | no | Who is live, what they run, what they charge |
| `xorv_network_status` | no | Providers, settled volume, facilitator, audit log contract |
| `xorv_quote` | no | Price a job without paying |
| `xorv_run_job` | **yes** | Quote, pay over x402 (escrowed when offered; `token` picks USDG or USDC), wait for the result, return it with Arbiscan links — or the refund, if the job failed |
| `xorv_get_job` | no | Look up a job by id |

## Escrow

When the broker offers it, the agent's payment goes into XorvEscrow, not to the provider. It is released
when the result arrives and refunded if the job fails; the agent signs one EIP-712 message whose nonce is
derived from the job, so the signature can't fund anything else.

## Why the ceiling

A model that can spend without a bound is a model that can empty an account through a loop it didn't mean
to write. `xorv_run_job` refuses anything over `XORV_MAX_USD`, client-side, before it signs.

MIT
