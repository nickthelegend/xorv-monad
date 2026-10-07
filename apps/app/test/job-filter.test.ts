import { describe, expect, it } from "vitest";
import type { Job } from "@/lib/api";
import { ALL, filterJobs, outcomeCounts, outcomeOf, providersIn } from "@/lib/job-filter";

let n = 0;
function job(overrides: Partial<Job> & { escrow?: "funded" | "released" | "refunded" } = {}): Job {
  const { escrow, ...rest } = overrides;
  n += 1;
  return {
    id: `job_${n}`,
    title: null,
    prompt: `prompt number ${n}`,
    private: false,
    status: "completed",
    createdAt: 1_000 + n,
    providerId: "prv_a",
    providerLabel: "atlas",
    priceUsdMicros: 1_000,
    payment: escrow ? { escrow: { state: escrow } } : null,
    ...rest,
  } as unknown as Job;
}

describe("job browsing", () => {
  const jobs = [
    job({ escrow: "released" }),
    job({ status: "failed", error: "cancelled by the buyer", escrow: "refunded" } as Partial<Job>),
    job({ status: "failed", error: "adapter crashed" } as Partial<Job>),
    job({ status: "running", providerId: "prv_b", providerLabel: "borealis", escrow: "funded" }),
    job({ status: "assigned" as Job["status"], providerId: "prv_b", providerLabel: "borealis" }),
    job({ status: "expired" as Job["status"] }),
    job({ private: true, prompt: "", title: null }),
  ];

  it("buckets jobs by what happened to the buyer: refunded is not failed, in-flight is running", () => {
    expect(jobs.map(outcomeOf)).toEqual(["completed", "refunded", "failed", "running", "running", "failed", "completed"]);
    expect(outcomeCounts(jobs)).toEqual({ all: 7, completed: 2, refunded: 1, running: 2, failed: 2 });
  });

  it("filters by outcome and provider together, newest first", () => {
    expect(filterJobs(jobs, { ...ALL, outcome: "running", provider: "prv_b" }).map((j) => j.id)).toEqual([jobs[4]!.id, jobs[3]!.id]);
    expect(filterJobs(jobs, { ...ALL, outcome: "refunded" })).toHaveLength(1);
    expect(filterJobs(jobs, ALL)[0]!.id).toBe(jobs[6]!.id);
  });

  it("searches prompt, provider and job id, and never a private job's text", () => {
    expect(filterJobs(jobs, { ...ALL, text: `number ${n - 6}` }).map((j) => j.id)).toEqual([jobs[0]!.id]);
    expect(filterJobs(jobs, { ...ALL, text: "BOREALIS" })).toHaveLength(2);
    expect(filterJobs(jobs, { ...ALL, text: jobs[6]!.id })).toHaveLength(1);
    expect(filterJobs(jobs, { ...ALL, text: "prompt" }).some((j) => j.private)).toBe(false);
  });

  it("lists the providers present, busiest first", () => {
    expect(providersIn(jobs)).toEqual([
      { id: "prv_a", label: "atlas", count: 5 },
      { id: "prv_b", label: "borealis", count: 2 },
    ]);
  });
});
