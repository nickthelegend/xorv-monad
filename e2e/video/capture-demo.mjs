/**
 * The narrated demo, captured from the live hosted app on Monad testnet (follows docs/RECORDING-RUNBOOK.md).
 *
 * Playwright drives the app at 1920x1080 with a visible cursor that glides to each target before it clicks.
 * Each beat holds the screen for at least its narration line (from <work>/vo/lines.json), and the caption
 * bar shows that line's words on the narration's own clock. The beat start times go to <work>/beats.json,
 * so assemble.py lays each line's audio exactly where its beat began.
 *
 * It buys one real job from the demo account (no login): 0.02 test USDC, about 0.15 MON of the team's gas.
 * After the take it checks the narration's claim on chain: the Kimi verdict's ERC-8004 feedback must
 * land no later than the release. If it doesn't, the take fails and isn't used.
 *
 *   node e2e/video/capture-demo.mjs <work dir>
 */
import { chromium } from "playwright";
import { mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http } from "viem";

const work = process.argv[2];
const APP = "https://xorv-monad-app.vercel.app";
const BROKER = "https://broker-production-2d62.up.railway.app";
const CRE_REFUND_TX = "0xa85c2f69d7ccb7fea3d3d574d453f9974125b493675d626a2e037e8002decd15";
const PROMPT = "In two sentences: why should an AI agent's payment wait in escrow until a verifier checks the work?";
const lines = Object.fromEntries(JSON.parse(readFileSync(join(work, "vo", "lines.json"), "utf8")).filter((l) => l.part === "demo").map((l) => [l.beat, l]));
const GAP = 0.45;

const dir = mkdtempSync(join(tmpdir(), "xorv-demo-"));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir, size: { width: 1920, height: 1080 } }, colorScheme: "dark", bypassCSP: true });
const page = await ctx.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));

// --------------------------------------------------------------- the overlay: cursor, live tag, caption bar
await ctx.addInitScript(() => {
  const mount = () => {
    if (document.getElementById("v-cursor")) return;
    const st = document.createElement("style");
    st.textContent = `#v-cursor{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;transform:translate(var(--x,960px),var(--y,540px));transition:transform .75s cubic-bezier(.22,.9,.3,1)}
      #v-cursor svg{width:30px;height:30px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.6))}
      #v-ring{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #4C9BFF;z-index:2147483646;pointer-events:none;opacity:0;transform:scale(.4)}
      #v-ring.go{animation:vr .5s ease-out}
      @keyframes vr{0%{opacity:.9;transform:scale(.4)}100%{opacity:0;transform:scale(1.6)}}
      #v-tag{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;font:600 14px/1 Inter,system-ui,sans-serif;letter-spacing:.14em;color:#4ade80;background:rgba(8,8,10,.85);border:1px solid rgba(74,222,128,.45);padding:8px 14px;border-radius:999px;pointer-events:none}
      #v-cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483645;padding:26px 140px 34px;text-align:center;font:500 34px/1.3 Inter,system-ui,sans-serif;color:#f4f4f5;background:linear-gradient(transparent,rgba(8,8,10,.94) 30%);min-height:120px;pointer-events:none}
      #v-cap:empty{background:none}`;
    document.head.appendChild(st);
    const c = document.createElement("div");
    c.id = "v-cursor";
    c.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.6L21 10.9z" fill="#fff" stroke="#08080a" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    const r = document.createElement("div"); r.id = "v-ring";
    const t = document.createElement("div"); t.id = "v-tag"; t.textContent = sessionStorage.getItem("v-tag") || "LIVE · MONAD TESTNET";
    const cap = document.createElement("div"); cap.id = "v-cap";
    document.body.append(c, r, t, cap);
    const pos = JSON.parse(sessionStorage.getItem("v-pos") || "[960,540]");
    c.style.transition = "none"; c.style.setProperty("--x", pos[0] + "px"); c.style.setProperty("--y", pos[1] + "px");
    requestAnimationFrame(() => { c.style.transition = ""; });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  setInterval(mount, 250);
});

async function cursorTo(x, y) {
  await page.evaluate(([x, y]) => {
    const c = document.getElementById("v-cursor");
    c.style.setProperty("--x", x + "px"); c.style.setProperty("--y", y + "px");
    sessionStorage.setItem("v-pos", JSON.stringify([x, y]));
  }, [x, y]);
  await page.waitForTimeout(800);
}
async function point(locator) {
  // Never fatal: a label that isn't on screen costs a cursor move, not a paid take.
  const el = locator.first();
  try { await el.scrollIntoViewIfNeeded({ timeout: 8_000 }); } catch { return null; }
  const b = await el.boundingBox();
  if (!b) return null;
  await cursorTo(Math.round(b.x + Math.min(b.width / 2, 120)), Math.round(b.y + b.height / 2));
  return b;
}
async function click(locator) {
  const b = await point(locator);
  if (!b) throw new Error("nothing to click");
  await page.evaluate(([x, y]) => {
    const r = document.getElementById("v-ring");
    r.style.left = x + "px"; r.style.top = y + "px"; r.classList.remove("go"); void r.offsetWidth; r.classList.add("go");
  }, [Math.round(b.x + Math.min(b.width / 2, 120)), Math.round(b.y + b.height / 2)]);
  await locator.first().click();
}
async function tag(text) {
  await page.evaluate((t) => { sessionStorage.setItem("v-tag", t); const el = document.getElementById("v-tag"); if (el) el.textContent = t; }, text);
}
async function smoothScroll(y, ms = 1400) {
  await page.evaluate(([to, dur]) => new Promise((done) => {
    const from = scrollY, s = performance.now();
    const step = (t) => { const k = Math.min(1, (t - s) / dur); scrollTo(0, from + (to - from) * (1 - Math.pow(1 - k, 3))); k < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  }), [y, ms]);
}
async function scrollToText(text, offset = 160) {
  const b = await page.getByText(text).first().boundingBox();
  if (b) await smoothScroll(Math.max(0, (await page.evaluate(() => scrollY)) + b.y - offset));
}

// --------------------------------------------------------------- beats: hold the screen for the narration
const beats = {};
let current = null;
function chunks(words, maxWords = 7) {
  const out = []; let cur = [];
  for (const w of words) { cur.push(w); if (cur.length >= maxWords || (/[.,:;!?]$/.test(w[0]) && cur.length >= 3)) { out.push(cur); cur = []; } }
  if (cur.length) out.push(cur);
  return out.map((c) => ({ start: c[0][1], end: c[c.length - 1][2] + 0.25, text: c.map((x) => x[0]).join(" ") }));
}
async function beat(name) {
  if (current) await current;
  const line = lines[name];
  beats[name] = now();
  // Captions run on the page's clock from this instant, the same instant the line's audio starts in the edit.
  await page.evaluate((caps) => {
    const start = performance.now();
    const tick = () => {
      const el = document.getElementById("v-cap"); if (!el) return requestAnimationFrame(tick);
      const t = (performance.now() - start) / 1000;
      const c = caps.find((c) => t >= c.start && t < c.end);
      el.textContent = c ? c.text : "";
      if (t < caps[caps.length - 1].end + 0.2) requestAnimationFrame(tick); else el.textContent = "";
    };
    requestAnimationFrame(tick);
  }, chunks(line.words));
  const until = Date.now() + (line.seconds + GAP) * 1000;
  current = (async () => { const left = until - Date.now(); if (left > 0) await page.waitForTimeout(left); })();
}
async function captionsAgain(name) {
  // A page navigation drops the caption ticker; restart it at the line's current position.
  const line = lines[name]; const elapsed = now() - beats[name];
  await page.evaluate(([caps, off]) => {
    const start = performance.now() - off * 1000;
    const tick = () => {
      const el = document.getElementById("v-cap"); if (!el) return requestAnimationFrame(tick);
      const t = (performance.now() - start) / 1000;
      const c = caps.find((c) => t >= c.start && t < c.end);
      el.textContent = c ? c.text : "";
      if (t < caps[caps.length - 1].end + 0.2) requestAnimationFrame(tick); else el.textContent = "";
    };
    requestAnimationFrame(tick);
  }, [chunks(line.words), elapsed]);
}
async function go(path, name) {
  await page.goto(APP + path, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#v-cap");
  if (name && beats[name] !== undefined) await captionsAgain(name);
}

let jobId = null;
try {
  // 1. Monad, live
  await go("/network");
  await page.getByText("median to finalized").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  await beat("network");
  await point(page.getByText("median to finalized"));
  await page.waitForTimeout(2500);
  await point(page.getByText(/Proposed|Voted|Finalized/).first());
  // 2. validators
  await beat("validators");
  await scrollToText("Who secures the payments", 140);
  await point(page.getByText("proposing now"));
  // 3. the quote (the validators line finishes on its own page first)
  await current;
  await go("/", null);
  await page.waitForTimeout(1200);
  await beat("quote");
  const box = page.locator("textarea").first();
  await click(box);
  await box.pressSequentially(PROMPT, { delay: 14 });
  await click(page.getByRole("button", { name: "Get a quote" }));
  await page.getByRole("button", { name: /from demo account/i }).waitFor({ timeout: 30_000 });
  await point(page.getByText(/Xorv hosted · Kimi K3/).last());
  // 4. pay
  await beat("pay");
  const payBtn = page.getByRole("button", { name: /from demo account/i });
  await point(payBtn);
  await page.waitForTimeout(1500);
  await click(payBtn);
  await page.waitForURL(/\/jobs\/job_/, { timeout: 90_000 });
  jobId = page.url().match(/jobs\/(job_[\w-]+)/)[1];
  await page.waitForSelector("#v-cap");
  await captionsAgain("pay");
  // 5. the money moves (live)
  await beat("timeline");
  await point(page.getByText("Where the money is"));
  await page.locator('[data-step="settled"][data-state="done"]').waitFor({ timeout: 180_000 });
  // The verdict reaches this page on the next load: wait until it is on chain, then reload.
  for (let i = 0; i < 60; i++) {
    const j = await (await fetch(`${BROKER}/api/jobs/${jobId}`)).json();
    if ((j.job ?? j).verification?.feedbackTxHash) break;
    await page.waitForTimeout(1000);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#v-cap");
  await captionsAgain("timeline");
  await page.locator('[data-step="settled"]').first().waitFor({ timeout: 30_000 });
  await point(page.locator('[data-step="settled"]'));
  // 6. speed receipt
  await beat("speed");
  await point(page.getByText("payment final"));
  await page.waitForTimeout(2500);
  await point(page.getByText(/^release$/).first()).catch(() => {});
  // 7. verdict
  await beat("verdict");
  await scrollToText("Network checks", 200);
  await point(page.getByText(/Verified by Kimi/));
  await page.waitForTimeout(2500);
  await point(page.getByText(/ERC-8004 feedback/).first()).catch(() => {});
  // 8. the release on chain
  await beat("release");
  const job = await (await fetch(`${BROKER}/api/jobs/${jobId}`)).json();
  const held = (job.job ?? job).payment.escrow;
  await go(`/chain/tx/${held.releaseTx}`, "release");
  await page.getByText("Events").first().waitFor({ timeout: 30_000 });
  await point(page.getByText(/^Transfer$/).first());
  // 9. provider
  await beat("provider");
  await go(`/providers/${(job.job ?? job).providerId}`, "provider");
  await page.getByText("Earnings").first().waitFor({ timeout: 30_000 });
  await point(page.getByText(/agent #/).first()).catch(() => {});
  await page.waitForTimeout(1800);
  await scrollToText("Earnings", 140);
  // 10. CRE refund (a simulation broadcast; labelled)
  await beat("refund");
  await tag("MONAD TESTNET · CHAINLINK CRE SIMULATION");
  await go(`/chain/tx/${CRE_REFUND_TX}`, "refund");
  await page.getByText("JobRefunded").first().waitFor({ timeout: 30_000 });
  await point(page.getByText("JobRefunded").first());
  await page.waitForTimeout(2500);
  await point(page.getByText("KeeperRefunded").first()).catch(() => {});
  await current;
  await page.waitForTimeout(600);
  beats.end = now();
} finally {
  await ctx.close();
  await browser.close();
}

// --------------------------------------------------------------- the narration's claim, checked on chain
const final = await (await fetch(`${BROKER}/api/jobs/${jobId}`)).json();
const j = final.job ?? final;
const rpc = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz") });
const at = async (h) => { const r = await rpc.getTransactionReceipt({ hash: h }); return [Number(r.blockNumber), r.transactionIndex]; };
const fb = j.verification?.feedbackTxHash ? await at(j.verification.feedbackTxHash) : null;
const rel = j.payment.escrow.releaseTx ? await at(j.payment.escrow.releaseTx) : null;
const ordered = fb && rel && (fb[0] < rel[0] || (fb[0] === rel[0] && fb[1] < rel[1]));
const raw = join(dir, readdirSync(dir).find((f) => f.endsWith(".webm")));
renameSync(raw, join(work, "demo.webm"));
const evidence = { jobId, payment: j.payment.txHash, timing: j.payment.timing, verdict: j.verification ? { score: j.verification.score, pass: j.verification.pass, feedbackTx: j.verification.feedbackTxHash, at: fb } : null, release: { tx: j.payment.escrow.releaseTx, at: rel }, ordered, errors };
writeFileSync(join(work, "beats.json"), JSON.stringify({ beats, evidence }, null, 2));
console.log(JSON.stringify(evidence));
if (!ordered) { console.error("take rejected: the verdict did not land on chain before the release"); process.exit(2); }
