/**
 * Every screen and flow in the app, the way a visitor meets them.
 *
 * Each test fails on any console error, uncaught page error, failed request or
 * unexpected HTTP error, so "renders" also means "renders cleanly". Responses a
 * flow is meant to produce (a 422 for an impossible quote, a 404 for a job that
 * doesn't exist) are expected explicitly and asserted on instead.
 */
import { expect, test, type Page } from "@playwright/test";

const PHONE = { width: 375, height: 812 };

interface Watch {
  problems: string[];
  allow: (pattern: RegExp) => void;
}

function watch(page: Page): Watch {
  const problems: string[] = [];
  const allowed: RegExp[] = [];
  const ok = (url: string) => allowed.some((p) => p.test(url));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const at = msg.location()?.url ?? "";
    if (ok(at) || allowed.some((p) => p.test(msg.text()))) return;
    problems.push(`console: ${msg.text()} (${at})`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => {
    // A navigation away cancels in-flight polls; that is not a failure.
    if (req.failure()?.errorText === "net::ERR_ABORTED") return;
    if (!ok(req.url())) problems.push(`request failed: ${req.method()} ${req.url()} ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && !ok(res.url())) problems.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`);
  });
  return { problems, allow: (p) => allowed.push(p) };
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, "no horizontal scroll").toBeLessThanOrEqual(client);
}

let jobUrl = "";

test.describe.configure({ mode: "serial" });

test("board: composer, recent jobs and live providers", async ({ page }) => {
  const w = watch(page);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "What needs doing?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get a quote" })).toBeVisible();
  await expect(page.getByText("Live providers")).toBeVisible();
  await expect(page.getByText("local-stack-node").first()).toBeVisible();
  expect(w.problems).toEqual([]);
});

test("quote: refuses a zero price before asking the broker", async ({ page }) => {
  const w = watch(page);
  await page.goto("/");
  await page.getByRole("textbox", { name: "What needs doing?" }).fill("Explain EIP-3009 in one sentence.");
  await page.getByRole("textbox", { name: "Most you'll pay in US dollars" }).fill("0");
  await page.getByRole("button", { name: "Get a quote" }).click();
  await expect(page.getByText("Set a maximum price above zero.")).toBeVisible();
  expect(w.problems).toEqual([]);
});

test("quote: a ceiling below every provider is refused with the reason", async ({ page }) => {
  const w = watch(page);
  w.allow(/\/api\/quotes$/);
  await page.goto("/");
  await page.getByRole("textbox", { name: "What needs doing?" }).fill("Explain EIP-3009 in one sentence.");
  await page.getByRole("textbox", { name: "Most you'll pay in US dollars" }).fill("0.01");
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/quotes"));
  await page.getByRole("button", { name: "Get a quote" }).click();
  expect((await answer).status()).toBe(422);
  await expect(page.getByText(/cheapest/i)).toBeVisible();
  // Only the expected 422 may appear; the browser logs it as a console error too.
  expect(w.problems.filter((p) => !/422/.test(p))).toEqual([]);
});

test("buy: quote → pay from the demo account → job runs → escrow released", async ({ page }) => {
  const w = watch(page);
  await page.goto("/");
  await page.getByRole("textbox", { name: "What needs doing?" }).fill("In one sentence: what does an escrow protect a buyer from?");
  await page.getByRole("textbox", { name: "Most you'll pay in US dollars" }).fill("0.50");
  await page.getByRole("button", { name: "Get a quote" }).click();
  const pay = page.getByRole("button", { name: /Run it — the demo account pays \$/ });
  await expect(pay).toBeVisible();
  await expect(page.getByText(/held in escrow until the job delivers/)).toBeVisible();
  await pay.click();
  await page.waitForURL(/\/jobs\/job_/, { timeout: 120_000 });
  jobUrl = page.url();
  await expect(page.getByText("Completed").first()).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText("Result", { exact: true })).toBeVisible();
  await expect(page.getByText("released", { exact: true })).toBeVisible({ timeout: 60_000 });
  expect(w.problems).toEqual([]);
});

test("job page: links into the chain viewer", async ({ page }) => {
  test.skip(!jobUrl, "needs the purchase above");
  const w = watch(page);
  await page.goto(jobUrl);
  await page.getByRole("link", { name: /View escrow deposit on the chain viewer/ }).click();
  await expect(page.getByRole("heading", { name: "Transaction" })).toBeVisible();
  await expect(page.getByText(/success/i).first()).toBeVisible();
  expect(w.problems).toEqual([]);
});

test("providers: the live node with its on-chain record", async ({ page }) => {
  const w = watch(page);
  await page.goto("/providers");
  await expect(page.getByText("local-stack-node").first()).toBeVisible();
  await expect(page.getByText(/on-chain/).first()).toBeVisible();
  expect(w.problems).toEqual([]);
});

test("network: settlement, contracts, identity and signing, history, audit log", async ({ page }) => {
  const w = watch(page);
  await page.goto("/network");
  for (const heading of ["Settlement", "Contracts", "Identity and signing", "History", "Audit log"]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  // Without Privy keys the broker says so, rather than claiming a policy.
  await expect(page.getByText("Privy not configured on this broker", { exact: false })).toBeVisible();
  await expect(page.getByText("off — anyone can fund and be paid")).toBeVisible();
  await expect(page.getByText("jobs funded")).toBeVisible();
  expect(w.problems).toEqual([]);
});

test("not found and invalid input: every dead end says what happened", async ({ page }) => {
  const w = watch(page);
  w.allow(/\/api\/jobs\/job_doesnotexist/);
  w.allow(/\/this-page-does-not-exist/);
  w.allow(/404/);
  await page.goto("/jobs/job_doesnotexist");
  await expect(page.getByText("Job not found")).toBeVisible();
  await page.goto("/chain/tx/0x1234");
  await expect(page.getByText("Not a transaction hash")).toBeVisible();
  await page.goto(`/chain/tx/0x${"0".repeat(64)}`);
  await expect(page.getByText("Transaction not found")).toBeVisible();
  await page.goto("/chain/address/not-an-address");
  await expect(page.getByText("Not an address")).toBeVisible();
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByRole("link").first()).toBeVisible();
  expect(w.problems).toEqual([]);
});

test("chain viewer front page: the deployment's contracts and a lookup", async ({ page }) => {
  const w = watch(page);
  await page.goto("/chain");
  await expect(page.getByRole("heading", { name: "Chain" })).toBeVisible();
  await expect(page.getByText("latest block")).toBeVisible();
  await expect(page.getByText("XorvEscrow")).toBeVisible();
  // A bad lookup says why; a real address goes to its page.
  await page.getByLabel("Transaction hash or address").fill("nonsense");
  await page.getByRole("button", { name: "Look up" }).click();
  // By text: Next.js adds its own role="alert" route announcer.
  await expect(page.getByText(/is neither a transaction hash/)).toBeVisible();
  const escrow = (await page.getByRole("link").filter({ hasText: /^0x[0-9a-fA-F]{40}$/ }).first().textContent())!;
  await page.getByLabel("Transaction hash or address").fill(escrow);
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page).toHaveURL(new RegExp(`/chain/address/${escrow}`));
  await expect(page.getByRole("heading", { name: "Contract" })).toBeVisible();
  expect(w.problems).toEqual([]);
});

test("375px: every page fits a phone", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const w = watch(page);
  for (const path of ["/", "/providers", "/network", "/chain", ...(jobUrl ? [new URL(jobUrl).pathname] : [])]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => {});
    await noHorizontalScroll(page);
  }
  expect(w.problems).toEqual([]);
});
