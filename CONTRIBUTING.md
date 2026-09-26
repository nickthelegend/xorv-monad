# Contributing

## Setup

```bash
pnpm install
cp .env.example .env          # a testnet account takes ~60s at portal.hedera.com
pnpm --filter @xorv/broker setup   # creates the 3 HCS topics + demo accounts
pnpm build
pnpm test
```

Three terminals to run the whole thing:

```bash
pnpm broker    # coordinator + facilitator on :8402
xorv start     # a provider node
pnpm app       # job board on :3002
```

## Before you open a PR

```bash
pnpm typecheck && pnpm test && pnpm build
```

CI runs exactly that on Node 22 and 24, plus a check that the CLI still starts
on its declared floor of 20.11, plus a scan for committed key material.

## Writing an adapter

An adapter is one class with two methods. Put it in `packages/cli/src/adapters/`
and register it in `adapters/index.ts`:

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

Rules that aren't obvious:

- **Report only what the CLI actually tells you.** If it doesn't emit tool
  calls, don't infer them by diffing the directory — that puts guesses in the
  job log wearing the same clothes as facts.
- **Honour `input.signal`.** Jobs get cancelled and time out.
- **Respect `safeMode()`.** In safe mode the adapter must not touch the disk or
  run a shell.
- **Never trust the prompt.** It came from a stranger.

## Style

The code is commented for the reader who has to change it in six months. Explain
*why*, especially where something looks wrong and isn't — see the SDK client
notes in `ARCHITECTURE.md` for the tone.

Tests assert behaviour, not implementation. Every bug fixed should arrive with
the test that would have caught it.

## Security

See `SECURITY.md`. Don't open a public issue for anything exploitable — email
niveshgajengi@gmail.com.
