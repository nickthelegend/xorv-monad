/**
 * The demo video, recorded from the live hosted product on Monad testnet (13 Oct 2026).
 *
 * Playwright drives the hosted app at 1920×1080 and records it with its own recorder. A caption bar at the
 * bottom of the frame says what is happening. Nothing is staged: the paid job in the middle is bought live,
 * by an MCP agent paying from its policy-bounded Privy server wallet, while the camera watches the app. Every
 * number in a caption is read from the page or the broker at that moment. A beat that fails stops the
 * recording.
 *
 * ffmpeg turns the recording into H.264 at 1080p (docs/demo/xorv-demo.mp4) and writes the captions next to
 * it as an .srt.
 *
 *   node e2e/web/record-demo.mjs .env                      # the env file holding the agent's Privy keys
 *   APP=… BROKER=… node e2e/web/record-demo.mjs .env       # another deployment
 *
 * It spends one real job: $0.02 of testnet USDC from the agent's Privy wallet, and one Kimi call under the
 * hosted provider's daily cap.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APP = process.env.APP ?? "https://xorv-monad-app.vercel.app";
const BROKER = process.env.BROKER ?? "https://broker-production-2d62.up.railway.app";
const OUT = join(ROOT, "docs/demo/xorv-demo.mp4");
const VIEW = { width: 1920, height: 1080 };
/** The CRE refund of 13 Oct: an expired escrowed job, refunded by Chainlink CRE through XorvRefundKeeper. */
const CRE_REFUND_TX = "0xa85c2f69d7ccb7fea3d3d574d453f9974125b493675d626a2e037e8002decd15";
const PROMPT = "In three sentences: why should an AI agent's payment sit in escrow until the work is delivered?";

const envFile = process.argv[2];
if (!envFile) throw new Error("usage: node e2e/web/record-demo.mjs <env file with PRIVY_APP_ID, PRIVY_APP_SECRET, XORV_PRIVY_WALLET_ID>");
const secrets = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const dir = mkdtempSync(join(tmpdir(), "xorv-demo-"));
const browser = await chromium.launch();
// bypassCSP: the caption bar is an injected <style>, which the app's nonce CSP would otherwise refuse.
const context = await browser.newContext({ viewport: VIEW, recordVideo: { dir, size: VIEW }, colorScheme: "dark", bypassCSP: true });
const page = await context.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => errors.push(`pageerror ${e.message.slice(0, 200)}`));

// ---------------------------------------------------------------- captions: a bar across the bottom of the frame

const cues = [];
let current = null;
await context.addInitScript(() => {
  const mount = () => {
    if (document.getElementById("demo-caption")) return;
    const style = document.createElement("style");
    style.textContent = `#demo-caption{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:18px 48px 22px;
      background:rgba(8,8,10,.94);border-top:1px solid #2a2a30;font:500 26px/1.35 Inter,system-ui,sans-serif;color:#f4f4f5;pointer-events:none}
      #demo-caption b{display:block;font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:#4ade80;margin-bottom:6px}`;
    document.head.appendChild(style);
    const el = document.createElement("div");
    el.id = "demo-caption";
    document.body.appendChild(el);
    const saved = sessionStorage.getItem("demo-caption");
    if (saved) el.innerHTML = saved;
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
  // React may replace the document's children while it hydrates; put the bar back if it goes.
  setInterval(mount, 200);
});

async function caption(title, body) {
  if (current) current.end = now();
  current = { start: now(), end: null, title, body };
  cues.push(current);
  const html = `<b>${title}</b>${body}`;
  await page.evaluate((h) => {
    sessionStorage.setItem("demo-caption", h);
    const el = document.getElementById("demo-caption");
    if (el) el.innerHTML = h;
  }, html);
}

async function go(path) {
  await page.goto(APP + path, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#demo-caption");
}

const hold = (s) => page.waitForTimeout(s * 1000);
const json = async (path) => (await fetch(BROKER + path)).json();
const ms = (n) => `${Math.round(n).toLocaleString("en-US")} ms`;

async function smoothScroll(y, seconds = 1.5) {
  await page.evaluate(
    ([target, dur]) =>
      new Promise((done) => {
        const from = window.scrollY;
        const start = performance.now();
        const step = (t) => {
          const k = Math.min(1, (t - start) / dur);
          window.scrollTo(0, from + (target - from) * (1 - Math.pow(1 - k, 3)));
          if (k < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    [y, seconds * 1000],
  );
}

async function scrollTo(locator, offset = 120, seconds = 1.5) {
  const box = await locator.first().boundingBox();
  if (!box) throw new Error(`not on the page: ${locator}`);
  const y = await page.evaluate(() => window.scrollY);
  await smoothScroll(Math.max(0, y + box.y - offset), seconds);
}

// ---------------------------------------------------------------- the agent: an MCP client paying from its Privy wallet

async function agentBuys(prompt) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => typeof v === "string" && !/^(XORV_|PRIVY_|MOONSHOT|NANSEN)/.test(k)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "packages/mcp/dist/index.js")],
    stderr: "ignore",
    env: {
      ...base,
      XORV_SIGNER: "privy",
      XORV_PRIVY_APP_ID: secrets.PRIVY_APP_ID,
      XORV_PRIVY_APP_SECRET: secrets.PRIVY_APP_SECRET,
      XORV_PRIVY_WALLET_ID: secrets.XORV_PRIVY_WALLET_ID,
      XORV_BROKER_URL: BROKER,
      XORV_NETWORK: "eip155:10143",
      XORV_MAX_PRICE: "0.02",
      XORV_SESSION_BUDGET_USD: "0.05",
      XORV_AGENT_NAME: "demo-agent",
    },
  });
  const client = new Client({ name: "xorv-demo", version: "1.0.0" });
  await client.connect(transport);
  try {
    const out = await client.callTool({ name: "xorv_run_job", arguments: { prompt, adapter: "kimi", max_usd: 0.03 } }, undefined, { timeout: 240_000 });
    const text = out.content.map((x) => x.text ?? "").join("\n");
    if (out.isError) throw new Error(`the agent's job failed: ${text.slice(0, 300)}`);
    return text;
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------- the demo

try {
  // 1. The hook
  await go("/");
  await caption("Xorv on Monad", "A marketplace for AI work. Pay one job at a time in USDC, held in escrow until the work is delivered. Recorded live on Monad testnet.");
  await hold(6);

  // 2. Monad, live
  await go("/network");
  await caption("Monad testnet, live", "Every block, as Monad's consensus advances it: proposed, voted, finalized, verified. These are this browser's own timings.");
  await page.getByText("median to finalized").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => /\d+ ms/.test(document.body.innerText.split("median to finalized")[0].slice(-40)), null, { timeout: 30_000 });
  await hold(5);
  const medians = await page.evaluate(() => {
    const t = document.body.innerText;
    const grab = (label) => (t.split(label)[0].match(/(\d+) ms\s*$/) ?? [])[1];
    return { voted: grab("median to voted"), finalized: grab("median to finalized") };
  });
  await caption("Monad testnet, live", `Voted in about ${medians.voted} ms and final in about ${medians.finalized} ms. Xorv settles every payment on this, so a job's money is final in about a second.`);
  await hold(7);
  await scrollTo(page.getByText("Who secures the payments"));
  await caption("Who secures the payments", "The validator set finalizing those blocks, read live from Monad's staking precompile.");
  await hold(5);

  // 3. A quote in the browser
  await go("/");
  await caption("Ask the network", "A buyer describes the job. The broker picks a live provider and freezes the price, the provider and the escrow before anything is paid.");
  const box = page.locator("textarea").first();
  await box.click();
  await box.pressSequentially("Explain in three sentences why escrow matters when paying an AI agent per job.", { delay: 18 });
  await box.press("Meta+Enter");
  await page.getByText(/Log in to pay/).waitFor({ timeout: 30_000 });
  await hold(2);
  await caption("The quote", "Kimi K3 on a hosted provider node, $0.02. XorvEscrow holds the money and pays the provider only on delivery. A person logs in with Privy (Google) and pays from an embedded wallet; the buyer needs no MON.");
  await hold(9);

  // 4. An agent buys a job, live
  await caption("An AI agent buys a job", "Now an AI agent pays instead: an MCP server with a Privy server wallet. Its policy lets it sign only USDC payments of $0.05 or less, and only to Xorv's escrow or to providers.");
  const bought = agentBuys(PROMPT);
  bought.catch(() => {});
  await hold(3);
  let job = null;
  for (let i = 0; i < 90 && !job; i++) {
    const { jobs } = await json("/api/jobs?limit=10");
    job = jobs.find((j) => j.prompt === PROMPT && j.createdAt > t0 - 60_000) ?? null;
    if (!job) await page.waitForTimeout(1000);
  }
  if (!job) throw new Error("the agent's job never reached the broker");
  await go(`/jobs/${job.id}`);
  await caption("The money, live", "The agent's USDC goes into XorvEscrow on Monad. The provider runs the job, and on delivery the escrow releases the money with the result's hash, then the receipt lands on XorvLedger.");
  const text = await bought;
  await page.locator('[data-step="settled"][data-state="done"]').waitFor({ timeout: 120_000 });
  await hold(4);
  const done = (await json(`/api/jobs/${job.id}`)).job ?? (await json(`/api/jobs/${job.id}`));
  const pay = done.payment ?? {};
  const rel = pay.escrow?.settleTiming ?? {};
  await caption(
    "Settled on Monad",
    `Payment executed in ${ms(pay.timing.confirmMs)} and final in ${ms(pay.timing.finalMs)}. Release executed in ${ms(rel.confirmMs)} and final in ${ms(rel.finalMs)}. Each receipt came back in the send itself (eth_sendRawTransactionSync).`,
  );
  await hold(9);
  if (done.verification?.score != null) {
    await scrollTo(page.getByText("Network checks"), 160);
    await caption("Kimi verifies the work", `Kimi K3 reads the prompt and the answer and scores it ${done.verification.score}/100. A low score would count against the provider's reputation.`);
    await hold(7);
  }
  await smoothScroll(0, 1);

  // 5. The release on chain
  const releaseTx = pay.escrow?.releaseTx;
  if (releaseTx) {
    await go(`/chain/tx/${releaseTx}`);
    await page.getByText("Events").first().waitFor({ timeout: 30_000 });
    await caption("Check it on chain", "The release transaction, read straight from Monad: USDC from XorvEscrow to the provider, finalized. The buyer paid no gas; Xorv's facilitator did.");
    await hold(7);
  }

  // 6. The provider
  await go(`/providers/${done.providerId}`);
  await page.getByText("Earnings").first().waitFor({ timeout: 30_000 });
  await caption("The provider's side", "Each payout links to its Monad transaction. This node runs on Railway, sells Kimi K3, and has a persisted daily cap so free testnet USDC can't drain its model credit.");
  await hold(5);
  const trust = page.getByText(/Nansen/i).first();
  if (await trust.isVisible().catch(() => false)) {
    await scrollTo(trust, 200);
    await caption("Trust from Nansen", "Nansen profiles the provider's payout wallet: who funded it, its related wallets, and how old it is. The broker uses this to stop a provider rating itself through wallets it controls.");
    await hold(7);
  } else {
    await scrollTo(page.getByText("Earnings").first(), 140);
    await hold(5);
  }

  // 7. The refund promise, kept by Chainlink CRE
  await go(`/chain/tx/${CRE_REFUND_TX}`);
  await page.getByText("JobRefunded").first().waitFor({ timeout: 30_000 });
  await caption("If the work never comes, the buyer gets the money back", "Here an escrowed job expired undelivered. A Chainlink CRE workflow found it in the Envio index, XorvEscrow confirmed it was refundable, and the report went through the forwarder to XorvRefundKeeper.");
  await hold(6);
  await scrollTo(page.getByText("JobRefunded").first(), 200);
  await caption("Refunded on Monad", "The escrow refunded the buyer in full. No one at Xorv had to act, and no one could keep the money.");
  await hold(7);

  // 8. Close
  await go("/");
  await caption("Xorv on Monad", "Pay per job in USDC with a second to finality, escrow with refunds, receipts on XorvLedger and reputation in ERC-8004. Built with Privy, Kimi, Envio, Nansen and Chainlink CRE.");
  await hold(7);
  current.end = now();

  if (errors.length) console.log(`console errors during the take:\n  ${errors.join("\n  ")}`);
  console.log(text.split("\n").filter((l) => /^(Paid|Payment|Ledger|Verified|Job)/.test(l)).join("\n"));
} finally {
  await context.close();
  await browser.close();
}

// ---------------------------------------------------------------- encode

const raw = join(dir, readdirSync(dir).find((f) => f.endsWith(".webm")));
mkdirSync(dirname(OUT), { recursive: true });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", "-an", OUT]);
const stamp = (s) => {
  const t = Math.max(0, s);
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const sec = (t % 60).toFixed(3).replace(".", ",").padStart(6, "0");
  return `${h}:${m}:${sec}`;
};
writeFileSync(
  OUT.replace(/\.mp4$/, ".srt"),
  cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.title}: ${c.body}\n`).join("\n"),
);
const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT]).toString());
console.log(`${OUT}  ${duration.toFixed(1)} s`);
