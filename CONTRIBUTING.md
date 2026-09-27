# Contributing

## Setup

Node 22.18+ for the workspace (the broker needs 22.13+ for `node:sqlite`; the CLI and MCP server alone run on 20.19+) and pnpm 10
(`corepack enable`).

```bash
pnpm install
pnpm build                  # protocol first; every package resolves @xorv/protocol from its dist/
pnpm test                   # no keys, no RPC, no testnet funds
```

The first `pnpm build` downloads the Solidity compiler through Hardhat. After that, nothing in the
build or the tests needs the network.

### Running it against Monad testnet

```bash
cp .env.example .env        # everything is optional; each key adds a capability
pnpm setup:monad            # read-only: keys, MON/USDC balances, AI roles, ledger, what's missing
pnpm --filter @xorv/broker setup -- --new-keys   # also prints fresh EVM keys for .env
```

- **Faucets.** MON: <https://faucet.monad.xyz>. USDC: <https://faucet.circle.com> (pick Monad
  Testnet). Buyers need USDC only. The operator and facilitator EOAs need MON, kept above Monad's
  ~10 MON per-account reserve. Hedera ED25519 keys cannot be reused: Monad needs secp256k1.
- **With no keys**, the broker boots on `eip155:10143`, settles through Monad's hosted facilitator
  and reads the ledger read-only. That is enough to develop the app and the CLI against.
- **Your own ledger.** `XORV_BROKER_ADDRESS=<operator address> XORV_LEDGER_OWNER=<an address the
  broker's host doesn't hold> pnpm deploy:ledger` deploys XorvLedger (about 0.2 MON plus the reserve)
  and prints the `XORV_LEDGER_*` lines. On Monad networks the script refuses an owner that is the
  broker or the operator key ([packages/contracts/README.md](packages/contracts/README.md#deploy-and-verify)).
  A keyless dry run on an in-process chain: `pnpm --filter @xorv/contracts exec hardhat run scripts/deploy.ts`.
- **A private RPC** (`XORV_RPC_URL`) saves you from the public one's rate limit (25–50 rps) and its
  100-block `eth_getLogs` cap.

Then, in three terminals:

```bash
pnpm broker                                  # :8402, restarts on change
node packages/cli/dist/index.js init         # once
node packages/cli/dist/index.js start        # a provider node (`echo` works with nothing installed)
pnpm app                                     # :3002; apps/app/.env.local takes NEXT_PUBLIC_PRIVY_APP_ID
```

`pnpm landing` serves the marketing site on :3000. `pnpm mcp` runs the MCP server from source.

## Tests

```bash
pnpm test                                    # every workspace suite, sequentially
pnpm --filter @xorv/broker test              # one package
pnpm --filter @xorv/contracts test           # Hardhat 3 + node:test, against the vendored ERC-8004 registries
pnpm --filter @xorv/contracts gas:monad      # live Monad gas figures via eth_estimateGas (read-only, no key)
```

Rules the suite keeps, and that new tests must keep:

- **No keys, no network.** Stub at the chain boundary: the broker takes a `ChainLike` and an
  injectable facilitator, viem runs over the fake JSON-RPC in `test/support/fake-rpc.ts`, and model
  APIs are a scripted `fetch`. A test that needs a funded key or a live RPC will not get run.
- **Real code on the other side where possible.** The contracts test against the real ERC-8004
  registry code, the MCP mock broker verifies signatures, the MetaMask plugin's manifest is checked
  with MetaMask's own schema, and the passkey tests run real Mera.
- **Windows is a development platform.** POSIX-only cases (seatbelt, bubblewrap, file modes) are
  skipped on `win32` with a reason, not deleted.

### The Envio indexer (WSL or Docker)

`services/indexer` is **outside the pnpm workspace** (`!services/indexer` in
`pnpm-workspace.yaml`), because Envio 3.x ships no Windows binary. It has its own lockfile, and its
`node_modules` must never be installed from Windows.

- **Tests from Windows, in a throwaway container** (Docker Desktop, about 3 GB of RAM). The exact
  command is in [services/indexer/README.md](services/indexer/README.md#tests-in-a-throwaway-container-works-from-windows).
  It copies the package into the container, so Linux `node_modules` never touch the host, and runs
  `pnpm check` (`envio codegen && tsc --noEmit && vitest run`).
- **On WSL2, Linux or macOS:** `cd services/indexer && pnpm install && pnpm check`.
- **A local indexer with GraphQL:** `cp .env.example .env` (set `ENVIO_API_TOKEN` and the ledger
  address and start block), then `pnpm dev`. It starts Postgres and Hasura in Docker, and GraphQL is
  at `http://localhost:8080/v1/graphql`. Point the broker at it with `XORV_INDEXER_URL`.
- **After a contract change**, copy `packages/contracts/abi/XorvLedger.json` into
  `services/indexer/abis/`. The indexer's tests fail until you do.

## Before you open a PR

```bash
pnpm build && pnpm typecheck && pnpm test
```

CI runs exactly that on Node 22 and 24, builds the frontends, checks that the CLI still starts on
its declared floor of Node 20.19, and scans for committed key material. Never commit `.env`, keys,
`node_modules` or build output.

## Commit style

Look at `git log` and match it:

- **An imperative title that says what changed and why**, 72 characters or fewer. For example:
  "Settle x402 payments before dispatch so providers never work unpaid", not "fix payment bug" or
  "updates".
- **A short body explaining the reasoning**: what was wrong, what the change does about it, and
  anything a reviewer would otherwise have to work out from the diff.
- **One logical change per commit.** A refactor, a fix and a feature are three commits.
- **Stage explicit paths** (`git add <paths>`, never `git add -A`). Don't commit the root
  `pnpm-lock.yaml` in a change that doesn't need it.
- Work written with an AI coding assistant ends with a `Co-Authored-By:` trailer naming it, as the
  history since `321b563` does. The README's AI tools disclosure depends on it staying honest.

## Writing an adapter

An adapter is one class with two methods. Put it in `packages/cli/src/adapters/` and register it in
`adapters/index.ts`:

```ts
export class MyAdapter implements JobAdapter {
  readonly kind = "my-adapter";
  readonly installHint = "how to get the thing this drives";

  async available(): Promise<boolean> { return cliAvailable("mybin"); }

  async run(input: RunInput): Promise<string> {
    const result = await runChild({
      cmd: "mybin", args: ["-p", input.prompt],
      cwd: input.cwd, signal: input.signal,
      onLine: (line) => input.emit({ kind: "message", text: line }),
    });
    return clampResult(result.stdout);
  }
}
```

An adapter for an OpenAI-compatible hosted model does not need a child process at all. Add a preset
to `LLM_PRESETS` in `packages/protocol/src/llm.ts` and follow `packages/cli/src/adapters/hosted.ts`.
Add the new kind to `AdapterKind` in `packages/protocol/src/types.ts`.

Rules that aren't obvious:

- **Report only what the CLI actually tells you.** If it doesn't emit tool calls, don't infer them by
  diffing the directory. That puts guesses in the job log looking exactly like facts.
- **Honour `input.signal`.** Jobs get cancelled and time out.
- **Respect `safeMode()`.** In safe mode the adapter must not touch the disk or run a shell.
- **Keep keys out of the job.** Read API keys in-process, or pass them in the child's own environment.
  Never put them on argv, and never add them to the sandbox's environment allowlist.
- **Private jobs.** The node seals the result after your adapter returns, so an adapter needs no
  changes. But error text is reduced to a coarse vocabulary for private jobs, because adapter errors
  can quote the prompt.
- **Never trust the prompt.** It came from a stranger.

## Style

The code is commented for the reader who has to change it in six months. Explain *why*, especially
where something looks wrong and isn't: see [ARCHITECTURE.md](ARCHITECTURE.md) for the tone. Tests
assert behaviour, not implementation. Every bug fixed should arrive with the test that would have
caught it.

## Security

See [SECURITY.md](SECURITY.md). Don't open a public issue for anything exploitable: email
niveshgajengi@gmail.com.
