/**
 * Environments for the child processes: nothing inherited that could change
 * what is being tested.
 *
 * A developer's shell (or the repo-root .env the broker loads) may hold real
 * testnet keys, a Mongo URI, an indexer URL or live model keys. None of that
 * may leak into a run: the harness would then be testing someone's setup
 * rather than the code, and could spend real money. So every Xorv-ish
 * variable is dropped from the inherited environment, and for the broker —
 * which loads `.env` files with dotenv, which never overrides a variable that
 * is already set — every variable the repo documents is set explicitly, to
 * its test value or to "" (unset, as far as the broker's config is concerned).
 */

import fs from "node:fs";
import path from "node:path";

const DROPPED = /^(XORV_|MONAD_|NEXT_PUBLIC_|ENVIO_|DASHSCOPE_|MOONSHOT_|TOKENHUB_|HEDERA_|PRIVY_)/;

/** Read by the broker or the protocol, but only mentioned in .env.example's comments. */
const EXTRA_BROKER_VARS = [
  "XORV_QWEN_API_KEY",
  "XORV_QWEN_BASE_URL",
  "XORV_QWEN_MODEL",
  "XORV_KIMI_API_KEY",
  "XORV_KIMI_BASE_URL",
  "XORV_KIMI_MODEL",
  "XORV_HUNYUAN_API_KEY",
  "XORV_HUNYUAN_BASE_URL",
  "XORV_HUNYUAN_MODEL",
];

/** The inherited environment minus anything Xorv reads, with colour off for parseable output. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!DROPPED.test(key)) env[key] = value;
  }
  delete env.FORCE_COLOR;
  env.NO_COLOR = "1";
  return env;
}

/** Every variable .env.example documents, blanked, then `explicit` on top. */
export function sealedBrokerEnv(repoRoot: string, explicit: Record<string, string>): NodeJS.ProcessEnv {
  const env = cleanEnv();
  const example = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  for (const match of example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) env[match[1]!] = "";
  for (const name of EXTRA_BROKER_VARS) env[name] = "";
  return { ...env, ...explicit };
}
