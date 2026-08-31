import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trajectory, estimateCostUsd, hashPrompt, newRunId, type TrajectoryEntry } from "./trajectory.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wy-traj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readEntries(t: Trajectory): TrajectoryEntry[] {
  return readFileSync(t.path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TrajectoryEntry);
}

const usage = (over: Partial<Parameters<typeof estimateCostUsd>[1]> = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...over,
});

describe("cost estimation", () => {
  it("prices input and output at the model rate", () => {
    // gpt-5 is $1.25 in / $10 out per million.
    const cost = estimateCostUsd("gpt-5", usage({ inputTokens: 10_000, outputTokens: 5_000 }));
    expect(cost).toBeCloseTo(0.0125 + 0.05, 6);
  });

  it("prices cache reads far below fresh input", () => {
    const fresh = estimateCostUsd("gpt-5", usage({ inputTokens: 10_000 }));
    const cached = estimateCostUsd("gpt-5", usage({ cacheReadTokens: 10_000 }));
    expect(cached).toBeCloseTo(fresh * 0.1, 6);
  });

  it("charges no surcharge to write the cache", () => {
    // Unlike some providers, OpenAI's automatic caching has no write premium.
    const fresh = estimateCostUsd("gpt-5", usage({ inputTokens: 10_000 }));
    const written = estimateCostUsd("gpt-5", usage({ cacheWriteTokens: 10_000 }));
    expect(written).toBeCloseTo(fresh, 6);
  });

  it("does not bill reasoning tokens twice", () => {
    // Reasoning tokens are already inside outputTokens.
    const without = estimateCostUsd("gpt-5", usage({ outputTokens: 5_000 }));
    const with_ = estimateCostUsd("gpt-5", usage({ outputTokens: 5_000, reasoningTokens: 4_000 }));
    expect(with_).toBe(without);
  });

  it("bills a dated snapshot at its base model rate", () => {
    const u = usage({ inputTokens: 10_000, outputTokens: 5_000 });
    expect(estimateCostUsd("gpt-5-2026-01-15", u)).toBe(estimateCostUsd("gpt-5", u));
  });

  it("reports zero for a model it has no rate for, rather than a wrong number", () => {
    expect(estimateCostUsd("some-future-model", usage({ inputTokens: 1_000_000 }))).toBe(0);
  });

  it("charges gpt-5-mini less than gpt-5 for identical usage", () => {
    const u = usage({ inputTokens: 10_000, outputTokens: 5_000 });
    expect(estimateCostUsd("gpt-5-mini", u)).toBeLessThan(estimateCostUsd("gpt-5", u));
  });
});

describe("run ids and hashing", () => {
  it("produces a stable hash for identical prompt text", () => {
    expect(hashPrompt("compose the itinerary")).toBe(hashPrompt("compose the itinerary"));
    expect(hashPrompt("a")).not.toBe(hashPrompt("b"));
  });

  it("produces unique run ids", () => {
    expect(newRunId()).not.toBe(newRunId());
  });
});

describe("trajectory log", () => {
  it("writes one JSON object per line", () => {
    const t = new Trajectory("run_test_a", dir);
    t.start("wanderingyaks", "gpt-5", { caseId: "case-01" });
    t.step("verify", "3 hard violations");
    t.end("blocked");

    const entries = readEntries(t);
    expect(entries.map((e) => e.kind)).toEqual(["run_start", "step", "run_end"]);
  });

  it("writes each system prompt once and reuses its hash", () => {
    const t = new Trajectory("run_test_b", dir);
    const first = t.prompt("compose", "you are a tour operator");
    const second = t.prompt("compose", "you are a tour operator");

    expect(first).toBe(second);
    expect(readEntries(t).filter((e) => e.kind === "prompt")).toHaveLength(1);
  });

  it("distinguishes prompts that differ", () => {
    const t = new Trajectory("run_test_c", dir);
    t.prompt("compose", "prompt one");
    t.prompt("repair", "prompt two");
    expect(readEntries(t).filter((e) => e.kind === "prompt")).toHaveLength(2);
  });

  it("accumulates cost and latency across calls", () => {
    const t = new Trajectory("run_test_d", dir);
    const call = (costUsd: number, latencyMs: number) =>
      t.llmCall({
        stage: "compose",
        attempt: 1,
        systemHash: "abc",
        input: "in",
        output: {},
        usage: usage(),
        costUsd,
        latencyMs,
        stopReason: "end_turn",
      });

    call(0.1, 1000);
    call(0.25, 2000);

    expect(t.totals).toEqual({ costUsd: 0.35, latencyMs: 3000, llmCalls: 2 });

    t.end("sent");
    const end = readEntries(t).at(-1);
    expect(end).toMatchObject({ kind: "run_end", outcome: "sent", llmCalls: 2 });
  });

  it("records deterministic stages, not only model calls", () => {
    // The verifier rejecting a draft and repair responding to it is the most
    // interesting thing the system does, and involves no model call at all.
    const t = new Trajectory("run_test_e", dir);
    t.step("verify", "2 hard violations", { codes: ["CLOSED", "ALTITUDE_GAIN"] });
    t.step("price", "total $3,400");

    const steps = readEntries(t).filter((e) => e.kind === "step");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ stage: "verify", data: { codes: ["CLOSED", "ALTITUDE_GAIN"] } });
  });

  it("records the human checkpoint", () => {
    const t = new Trajectory("run_test_f", dir);
    t.human("approve", "operator-1", "swapped Deosai for Khaplu");

    const entry = readEntries(t).at(-1);
    expect(entry).toMatchObject({ kind: "human", action: "approve", operatorId: "operator-1" });
  });

  it("omits optional notes rather than writing null", () => {
    const t = new Trajectory("run_test_g", dir);
    t.human("send", "operator-1");
    expect(readEntries(t).at(-1)).not.toHaveProperty("notes");
  });

  it("logs failed attempts, not just successful ones", () => {
    const t = new Trajectory("run_test_h", dir);
    t.llmError("compose", 1, "schema validation failed: days: too small", 800);

    const entry = readEntries(t).at(-1);
    expect(entry).toMatchObject({ kind: "llm_error", stage: "compose", attempt: 1 });
    expect(t.totals.llmCalls).toBe(0);
  });
});
