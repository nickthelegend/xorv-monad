/**
 * The seam between `mm` and the plugin's plain-TypeScript core.
 *
 * Commands get a restricted `this.ctx` from the host — only the members their
 * manifest capabilities unlock — and a `CommandIO` for output. This file turns
 * those into the explicit dependencies `flows.ts` takes, and turns the core's
 * `XorvPluginError` back into the host's `CommandError`, so a failure renders
 * like any built-in `mm` error (code, message, hint; `_error` in `--json`).
 */

import { CommandError, type CommandIO, type PluginCommandContext } from "@metamask/agent-wallet/plugin";
import type { PublicClient } from "viem";
import { BrokerClient } from "./broker.js";
import { resolveBrokerUrl } from "./config.js";
import { XorvPluginError, errorMessage } from "./errors.js";
import type { WalletExecutor } from "./executor.js";
import type { Reporter } from "./flows.js";
import type { WalletStateSnapshot } from "./wallet.js";

export function toCommandError(err: unknown): Error {
  if (err instanceof CommandError) return err;
  if (err instanceof XorvPluginError) return new CommandError(err.code, err.message, err.hint || "See mm xorv --help.");
  return new CommandError(
    "XORV_UNEXPECTED",
    errorMessage(err) || "unexpected error",
    "Nothing was paid unless a settlement link was printed above. Re-run with --verbose for details.",
  );
}

/** Run a command body, converting any failure into a host `CommandError`. */
export async function hostCall<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    throw toCommandError(err);
  }
}

export function brokerFor(flag: string | null | undefined): BrokerClient {
  return new BrokerClient({ baseUrl: resolveBrokerUrl(flag) });
}

/** Progress lines: `emit` shows in the terminal and is dropped in `--json` mode, keeping stdout machine-readable. */
export function reporterFor(io: CommandIO): Reporter {
  return {
    line: (text) => io.emit(text),
    progress: (label) => io.progress(label),
  };
}

export function walletStateOf(ctx: PluginCommandContext): () => WalletStateSnapshot | null {
  return () => {
    try {
      return (ctx.walletStateManager?.read() ?? null) as WalletStateSnapshot | null;
    } catch {
      return null;
    }
  };
}

export function publicClientOf(ctx: PluginCommandContext): (chainId: number) => Pick<PublicClient, "readContract"> | null {
  return (chainId) => {
    try {
      return ctx.publicClient(chainId);
    } catch {
      return null;
    }
  };
}

/**
 * The wallet executor for one command. Requested only when a signature is
 * actually needed, and scoped to this command's id — the host checks the id
 * against the capabilities the user consented to at install time.
 */
export function executorOf(ctx: PluginCommandContext, io: CommandIO, commandId: string): () => Promise<WalletExecutor> {
  return async () => (await ctx.walletExecutor(io, commandId)) as unknown as WalletExecutor;
}
