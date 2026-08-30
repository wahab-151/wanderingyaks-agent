import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const TRAJECTORY_DIR = join(here, "..", "trajectories");

/**
 * Run logging. This file produces hackathon deliverable 04, so it is written
 * before any stage that would appear in a trajectory rather than bolted on at
 * the end - retrofitted logs read as an afterthought because they are one.
 *
 * A readable trajectory has to answer four questions: what the agent was told,
 * what it did, how its tools responded, and what made it change course. The
 * third and fourth are why deterministic stages log here too. The verifier
 * rejecting a draft and the repair loop responding to that rejection is the
 * most interesting thing this system does, and it involves no model call at
 * all - a log containing only LLM calls would omit the actual story.
 */

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type TrajectoryEntry =
  | { kind: "run_start"; runId: string; at: string; tenantId: string; model: string; caseId?: string; inquiry?: string }
  | { kind: "prompt"; runId: string; at: string; stage: string; systemHash: string; system: string }
  | {
      kind: "llm_call";
      runId: string;
      at: string;
      stage: string;
      attempt: number;
      systemHash: string;
      input: string;
      output: unknown;
      usage: TokenUsage;
      costUsd: number;
      latencyMs: number;
      stopReason: string | null;
    }
  | { kind: "llm_error"; runId: string; at: string; stage: string; attempt: number; error: string; latencyMs: number }
  | { kind: "step"; runId: string; at: string; stage: string; summary: string; data?: unknown }
  | { kind: "human"; runId: string; at: string; action: string; operatorId: string; notes?: string }
  | {
      kind: "run_end";
      runId: string;
      at: string;
      outcome: string;
      totalUsd: number;
      totalLatencyMs: number;
      llmCalls: number;
    };

/**
 * Per-million-token rates, from the Anthropic pricing table cached 2026-06-24.
 * Used to report cost per itinerary, which is one of the evaluation metrics.
 * Re-check against current pricing before quoting a figure in the README.
 */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Cache reads bill at roughly a tenth of the input rate and cache writes at
 * roughly 1.25x. Both are approximations of the published multipliers and are
 * good enough for a per-run cost estimate, not for billing.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const rate = RATES[model];
  if (!rate) return 0; // unknown model: report zero rather than a wrong number
  const inputUsd =
    (usage.inputTokens * rate.input +
      usage.cacheReadTokens * rate.input * 0.1 +
      usage.cacheWriteTokens * rate.input * 1.25) /
    1_000_000;
  const outputUsd = (usage.outputTokens * rate.output) / 1_000_000;
  return inputUsd + outputUsd;
}

export function hashPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function newRunId(): string {
  return `run_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 8)}`;
}

export class Trajectory {
  readonly runId: string;
  readonly path: string;

  private totalUsd = 0;
  private totalLatencyMs = 0;
  private llmCalls = 0;
  /** System prompts already written in full, so each is logged once per run. */
  private seenPrompts = new Set<string>();

  constructor(runId: string = newRunId(), dir: string = TRAJECTORY_DIR) {
    this.runId = runId;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${runId}.jsonl`);
  }

  private write(entry: TrajectoryEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private now(): string {
    return new Date().toISOString();
  }

  start(tenantId: string, model: string, meta: { caseId?: string; inquiry?: string } = {}): void {
    this.write({ kind: "run_start", runId: this.runId, at: this.now(), tenantId, model, ...meta });
  }

  /**
   * Logs the full system prompt the first time a stage uses it, and nothing
   * afterwards. Every llm_call carries the hash, so a reader can tie a call
   * back to its instructions without the prompt text repeating on every line.
   */
  prompt(stage: string, system: string): string {
    const systemHash = hashPrompt(system);
    if (!this.seenPrompts.has(systemHash)) {
      this.seenPrompts.add(systemHash);
      this.write({ kind: "prompt", runId: this.runId, at: this.now(), stage, systemHash, system });
    }
    return systemHash;
  }

  llmCall(e: {
    stage: string;
    attempt: number;
    systemHash: string;
    input: string;
    output: unknown;
    usage: TokenUsage;
    costUsd: number;
    latencyMs: number;
    stopReason: string | null;
  }): void {
    this.llmCalls += 1;
    this.totalUsd += e.costUsd;
    this.totalLatencyMs += e.latencyMs;
    this.write({ kind: "llm_call", runId: this.runId, at: this.now(), ...e });
  }

  llmError(stage: string, attempt: number, error: string, latencyMs: number): void {
    this.totalLatencyMs += latencyMs;
    this.write({ kind: "llm_error", runId: this.runId, at: this.now(), stage, attempt, error, latencyMs });
  }

  /** A deterministic stage: retrieval, verification, pricing, routing. */
  step(stage: string, summary: string, data?: unknown): void {
    this.write({ kind: "step", runId: this.runId, at: this.now(), stage, summary, data });
  }

  /** An operator decision. Approval and send are both recorded here. */
  human(action: string, operatorId: string, notes?: string): void {
    this.write({
      kind: "human",
      runId: this.runId,
      at: this.now(),
      action,
      operatorId,
      ...(notes === undefined ? {} : { notes }),
    });
  }

  end(outcome: string): void {
    this.write({
      kind: "run_end",
      runId: this.runId,
      at: this.now(),
      outcome,
      totalUsd: this.totalUsd,
      totalLatencyMs: this.totalLatencyMs,
      llmCalls: this.llmCalls,
    });
  }

  get totals(): { costUsd: number; latencyMs: number; llmCalls: number } {
    return { costUsd: this.totalUsd, latencyMs: this.totalLatencyMs, llmCalls: this.llmCalls };
  }
}
