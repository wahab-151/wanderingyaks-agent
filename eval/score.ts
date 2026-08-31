import type { DraftItinerary, Violation, ViolationCode } from "../src/schemas.js";
import type { KB } from "../src/kb.js";

/**
 * Turns a violation list into numbers that can be compared across systems.
 *
 * The central decision here is that "violations per itinerary" is not reported
 * as one figure, because a single figure would flatter the agent.
 *
 * Three of the codes - NO_INVENTORY, UNKNOWN_LOCATION, UNKNOWN_SEGMENT - are
 * won by the agent automatically. It composes from the knowledge base, so it
 * cannot name a hotel or a road that is not in it, while the baseline is
 * penalised for naming real places the knowledge base happens not to contain.
 * Counting those alongside the rest would measure "did the system read the KB",
 * which is true but nearly tautological, and it would hide the interesting
 * question: given real inventory, does the itinerary actually work?
 *
 * So violations are reported in three families, and the headline is FEASIBILITY.
 */

export const FAMILIES = {
  /** Does it use things that exist? The agent wins these by construction. */
  grounding: ["NO_INVENTORY", "UNKNOWN_LOCATION", "UNKNOWN_SEGMENT"],
  /** Can it physically and legally be run? This is the honest headline. */
  feasibility: ["CLOSED", "DRIVE_HOURS", "ALTITUDE_GAIN", "PERMIT_MISSING"],
  /** Does it match what the customer asked for? */
  fidelity: ["NIGHTS_MISMATCH", "BUDGET_EXCEEDED"],
  /** Could not be assessed. Not a failure of the itinerary. */
  advisory: ["UNVERIFIABLE_DATES"],
} as const satisfies Record<string, readonly ViolationCode[]>;

export type Family = keyof typeof FAMILIES;

const CODE_TO_FAMILY = new Map<ViolationCode, Family>(
  Object.entries(FAMILIES).flatMap(([family, codes]) =>
    codes.map((code) => [code, family as Family] as const),
  ),
);

export function familyOf(code: ViolationCode): Family {
  return CODE_TO_FAMILY.get(code) ?? "advisory";
}

export interface Scoreability {
  totalDays: number;
  /**
   * Days whose location resolved against the knowledge base, and which could
   * therefore be season-, altitude- and permit-checked at all.
   *
   * Reported because an itinerary nobody can assess is its own kind of result.
   * A system scoring zero feasibility violations across two checkable days out
   * of eight has not demonstrated anything, and the raw violation count alone
   * would not reveal that.
   */
  feasibilityCheckedDays: number;
  unknownLocations: string[];
}

export interface CaseScore {
  caseId: string;
  system: string;
  hard: number;
  soft: number;
  byFamily: Record<Family, number>;
  hardByFamily: Record<Family, number>;
  codes: ViolationCode[];
  scoreability: Scoreability;
  sendable: boolean;
  costUsd: number;
  latencyMs: number;
  llmCalls: number;
  /** How many repair rounds ran. Undefined for systems that have no loop. */
  repairAttempts?: number;
  /** Populated only when the run failed outright. */
  error?: string;
}

function emptyFamilyCounts(): Record<Family, number> {
  return { grounding: 0, feasibility: 0, fidelity: 0, advisory: 0 };
}

export function scoreability(draft: DraftItinerary, kb: KB): Scoreability {
  const unknown = draft.days.filter((d) => kb.location(d.location) === null);
  return {
    totalDays: draft.days.length,
    feasibilityCheckedDays: draft.days.length - unknown.length,
    unknownLocations: [...new Set(unknown.map((d) => d.location))],
  };
}

export function scoreCase(args: {
  caseId: string;
  system: string;
  draft: DraftItinerary;
  violations: Violation[];
  kb: KB;
  costUsd: number;
  latencyMs: number;
  llmCalls: number;
  repairAttempts?: number;
}): CaseScore {
  const byFamily = emptyFamilyCounts();
  const hardByFamily = emptyFamilyCounts();

  for (const v of args.violations) {
    const family = familyOf(v.code);
    byFamily[family] += 1;
    if (v.severity === "hard") hardByFamily[family] += 1;
  }

  const hard = args.violations.filter((v) => v.severity === "hard").length;

  return {
    caseId: args.caseId,
    system: args.system,
    hard,
    soft: args.violations.length - hard,
    byFamily,
    hardByFamily,
    codes: args.violations.map((v) => v.code),
    scoreability: scoreability(args.draft, args.kb),
    sendable: hard === 0,
    costUsd: args.costUsd,
    latencyMs: args.latencyMs,
    llmCalls: args.llmCalls,
    ...(args.repairAttempts === undefined ? {} : { repairAttempts: args.repairAttempts }),
  };
}

export interface Summary {
  system: string;
  cases: number;
  failedRuns: number;
  sendable: number;
  meanHard: number;
  meanFeasibilityHard: number;
  meanGroundingHard: number;
  meanFidelityHard: number;
  /** Mean fraction of days that could be feasibility-checked at all. */
  meanScoreableFraction: number;
  totalCostUsd: number;
  meanLatencyMs: number;
  /** Total repair rounds across all cases. Zero means the loop never fired. */
  totalRepairs: number;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function summarise(system: string, scores: CaseScore[]): Summary {
  const ok = scores.filter((s) => s.error === undefined);
  return {
    system,
    cases: scores.length,
    failedRuns: scores.length - ok.length,
    sendable: ok.filter((s) => s.sendable).length,
    meanHard: mean(ok.map((s) => s.hard)),
    meanFeasibilityHard: mean(ok.map((s) => s.hardByFamily.feasibility)),
    meanGroundingHard: mean(ok.map((s) => s.hardByFamily.grounding)),
    meanFidelityHard: mean(ok.map((s) => s.hardByFamily.fidelity)),
    meanScoreableFraction: mean(
      ok.map((s) =>
        s.scoreability.totalDays === 0
          ? 0
          : s.scoreability.feasibilityCheckedDays / s.scoreability.totalDays,
      ),
    ),
    totalCostUsd: scores.reduce((a, s) => a + s.costUsd, 0),
    meanLatencyMs: mean(ok.map((s) => s.latencyMs)),
    totalRepairs: ok.reduce((a, s) => a + (s.repairAttempts ?? 0), 0),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const n2 = (x: number) => x.toFixed(2);

export function renderMarkdown(summaries: Summary[], scores: CaseScore[]): string {
  const lines: string[] = [];

  lines.push("# Evaluation results", "");
  lines.push(`Generated ${new Date().toISOString()}`, "");

  lines.push("## Headline", "");
  lines.push(
    "Feasibility violations are the primary metric. Grounding violations are",
    "reported separately because the agent avoids them by construction - it can",
    "only compose from the knowledge base - so counting them together would",
    "overstate the difference between the systems.",
    "",
  );

  lines.push("| Metric | " + summaries.map((s) => s.system).join(" | ") + " |");
  lines.push("|---|" + summaries.map(() => "---").join("|") + "|");

  const row = (label: string, f: (s: Summary) => string) =>
    lines.push(`| ${label} | ` + summaries.map(f).join(" | ") + " |");

  row("**Feasibility violations / itinerary**", (s) => `**${n2(s.meanFeasibilityHard)}**`);
  row("Grounding violations / itinerary", (s) => n2(s.meanGroundingHard));
  row("Fidelity violations / itinerary", (s) => n2(s.meanFidelityHard));
  row("All hard violations / itinerary", (s) => n2(s.meanHard));
  row("Sendable without edits", (s) => `${s.sendable}/${s.cases}`);
  row("Days feasibility-checkable", (s) => pct(s.meanScoreableFraction));
  row("Repair rounds used (total)", (s) => String(s.totalRepairs));
  row("Cost per itinerary", (s) => `$${(s.totalCostUsd / Math.max(1, s.cases)).toFixed(4)}`);
  row("Latency per itinerary", (s) => `${(s.meanLatencyMs / 1000).toFixed(0)}s`);
  row("Runs that errored", (s) => String(s.failedRuns));

  lines.push("");
  lines.push("## Per case", "");
  lines.push("| Case | System | Feas. | Ground. | Fid. | Checkable | Sendable | Cost |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const s of scores) {
    const checkable = `${s.scoreability.feasibilityCheckedDays}/${s.scoreability.totalDays}`;
    lines.push(
      `| ${s.caseId} | ${s.system} | ${s.hardByFamily.feasibility} | ${s.hardByFamily.grounding} | ` +
        `${s.hardByFamily.fidelity} | ${checkable} | ${s.error ? "ERROR" : s.sendable ? "yes" : "no"} | ` +
        `$${s.costUsd.toFixed(4)} |`,
    );
  }

  lines.push("");
  lines.push("## Notes", "");
  lines.push(
    "- `Checkable` is the number of days whose location resolved against the",
    "  knowledge base. Feasibility checks cannot run on the others, so a low",
    "  number here means the feasibility column is based on little evidence.",
    "- Violation codes withheld from the repair loop are listed in",
    "  `DEFAULT_HELD_OUT` in `src/verify.ts`. They are scored here in full.",
  );

  return lines.join("\n") + "\n";
}
