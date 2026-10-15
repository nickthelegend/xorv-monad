// Hosted provider node: writes $XORV_HOME/config.json from the environment on
// first boot, then runs `xorv start`. The payout key never touches the file:
// the CLI reads it from XORV_PRIVATE_KEY.
//
//   XORV_PRIVATE_KEY        payout key (required)
//   XORV_BROKER_URL         broker to register with (required)
//   XORV_NODE_ID            stable node id, so restarts reuse the provider slot
//   XORV_NODE_LABEL         name buyers see
//   XORV_NODE_CAPABILITIES  JSON array of capabilities, as in config.json
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";

const need = (name) => {
  const v = process.env[name]?.trim();
  if (!v) { console.error(`${name} is not set`); process.exit(1); }
  return v;
};
const home = path.resolve(process.env.XORV_HOME || "/data/xorv");
const file = path.join(home, "config.json");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const config = {
  ...prev,
  nodeId: need("XORV_NODE_ID"),
  label: process.env.XORV_NODE_LABEL || "xorv-hosted",
  network: process.env.XORV_NETWORK || "eip155:10143",
  brokerUrl: need("XORV_BROKER_URL"),
  address: privateKeyToAccount(need("XORV_PRIVATE_KEY")).address,
  privateKey: "",
  agentId: process.env.XORV_AGENT_ID || prev.agentId || null,
  capabilities: JSON.parse(need("XORV_NODE_CAPABILITIES")),
  region: process.env.XORV_NODE_REGION || null,
  tunnel: { enabled: false, hostname: null },
  sandboxDir: path.join(home, "jobs"),
};
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
const child = spawn(process.execPath, ["packages/cli/dist/index.js", "start"], { stdio: "inherit", env: { ...process.env, XORV_HOME: home } });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
