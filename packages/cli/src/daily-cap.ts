/**
 * A daily spend guard for a node that sells a metered model.
 *
 * On testnet, USDC is free to anyone, so a public node selling a hosted model
 * (Kimi, Qwen) can be told to spend its operator's real model credit as fast as
 * strangers can post jobs. This caps jobs and tokens per UTC day. The counts are
 * persisted in `$XORV_HOME/daily-usage.json`, so a restart or redeploy doesn't
 * reset them.
 *
 * When the cap is reached, the node stops advertising capacity, so the broker
 * quotes no one and nobody pays. A job that still arrives (one matched just
 * before the cap filled) fails with "daily capacity reached", and the broker
 * refunds the escrow.
 *
 *   XORV_DAILY_JOB_CAP     jobs per UTC day (unset: no job cap)
 *   XORV_DAILY_TOKEN_CAP   model tokens per UTC day (unset: no token cap)
 *   XORV_DAILY_CAP_OFF=1   lift both caps, e.g. for the length of a demo recording
 */
import fs from "node:fs";
import path from "node:path";

export interface DailyUsage {
  day: string;
  jobs: number;
  tokens: number;
}

export interface DailyCapLimits {
  jobs: number | null;
  tokens: number | null;
  off: boolean;
}

export const CAPACITY_REACHED = "daily capacity reached: this node has used today's model budget; try again after 00:00 UTC";

function positiveInt(raw: string | undefined): number | null {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function capLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): DailyCapLimits {
  const off = env.XORV_DAILY_CAP_OFF === "1" || env.XORV_DAILY_CAP_OFF === "true";
  return { jobs: positiveInt(env.XORV_DAILY_JOB_CAP), tokens: positiveInt(env.XORV_DAILY_TOKEN_CAP), off };
}

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export class DailyCap {
  private readonly file: string;
  private readonly limits: DailyCapLimits;
  private readonly now: () => number;

  constructor(home: string, limits: DailyCapLimits = capLimitsFromEnv(), now: () => number = Date.now) {
    this.file = path.join(home, "daily-usage.json");
    this.limits = limits;
    this.now = now;
  }

  /** Is any cap configured and in force? */
  get active(): boolean {
    return !this.limits.off && (this.limits.jobs !== null || this.limits.tokens !== null);
  }

  usage(): DailyUsage {
    const day = utcDay(this.now());
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<DailyUsage>;
      if (saved.day === day) return { day, jobs: Number(saved.jobs) || 0, tokens: Number(saved.tokens) || 0 };
    } catch {
      // No file yet, or unreadable: a new day.
    }
    return { day, jobs: 0, tokens: 0 };
  }

  private save(u: DailyUsage): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(u), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Room for one more job today? */
  hasRoom(): boolean {
    if (!this.active) return true;
    const u = this.usage();
    if (this.limits.jobs !== null && u.jobs >= this.limits.jobs) return false;
    if (this.limits.tokens !== null && u.tokens >= this.limits.tokens) return false;
    return true;
  }

  /** Count a job against today's cap before it runs; false if there is no room. */
  claimJob(): boolean {
    if (!this.hasRoom()) return false;
    const u = this.usage();
    this.save({ ...u, jobs: u.jobs + 1 });
    return true;
  }

  /** Add a finished job's model tokens. */
  addTokens(tokens: number): void {
    if (!(tokens > 0)) return;
    const u = this.usage();
    this.save({ ...u, tokens: u.tokens + Math.ceil(tokens) });
  }

  describe(): string {
    if (this.limits.off) return "daily cap lifted (XORV_DAILY_CAP_OFF)";
    if (!this.active) return "no daily cap";
    const u = this.usage();
    const parts = [
      this.limits.jobs !== null ? `${u.jobs}/${this.limits.jobs} jobs` : null,
      this.limits.tokens !== null ? `${u.tokens}/${this.limits.tokens} tokens` : null,
    ].filter(Boolean);
    return `daily cap ${parts.join(", ")} (UTC ${u.day})`;
  }
}
