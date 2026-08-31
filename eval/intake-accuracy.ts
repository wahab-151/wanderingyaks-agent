import "dotenv/config";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Trajectory } from "../src/trajectory.js";
import { currentModel, LlmError } from "../src/llm.js";
import { intake } from "../src/stages.js";
import { loadCases } from "./load-cases.js";
import type { Brief } from "../src/schemas.js";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(here, "results");

/**
 * Measures how well intake reads an enquiry.
 *
 *   npm run eval:intake
 *
 * This is separate from the main evaluation because it measures a different
 * thing. `npm run eval` scores the itinerary that comes out of the pipeline;
 * this scores the brief that goes into it, against the brief pinned on each
 * case as the expected reading.
 *
 * It matters because a misread brief poisons everything downstream silently.
 * If intake decides "8 days" means 8 nights, the itinerary is a day too long,
 * the verifier reports NIGHTS_MISMATCH, and the real fault - a conversion at
 * the very first stage - is three modules away from where it surfaces.
 *
 * The fields are not weighted equally. Getting the nationality wrong changes
 * which permits apply and can make a trip illegal; getting the interests wrong
 * makes it slightly less well targeted. They are reported separately rather
 * than averaged into a single accuracy number that would hide the difference.
 */

interface FieldResult {
  field: string;
  expected: unknown;
  got: unknown;
  correct: boolean;
  /** Fields where being wrong makes the trip unrunnable rather than untidy. */
  critical: boolean;
}

interface CaseResult {
  caseId: string;
  fields: FieldResult[];
  criticalCorrect: number;
  criticalTotal: number;
  allCorrect: number;
  allTotal: number;
  costUsd: number;
  latencyMs: number;
  error?: string;
}

const sameSet = (a: string[], b: string[]): boolean => {
  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toUpperCase()))].sort().join(",");
  return norm(a) === norm(b);
};

/**
 * Dates are compared with a tolerance. "Late April" has no single right answer -
 * the 22nd and the 24th are both defensible readings - so anything inside the
 * window counts. A month or a year adrift does not.
 */
const dateWithin = (expected: string | null, got: string | null, days: number): boolean => {
  if (expected === null || got === null) return expected === got;
  const diff = Math.abs(Date.parse(`${expected}T00:00:00Z`) - Date.parse(`${got}T00:00:00Z`)) / 86_400_000;
  return diff <= days;
};

function compare(expected: Brief, got: Brief): FieldResult[] {
  return [
    { field: "groupSize", expected: expected.groupSize, got: got.groupSize, correct: expected.groupSize === got.groupSize, critical: true },
    { field: "nights", expected: expected.nights, got: got.nights, correct: expected.nights === got.nights, critical: true },
    {
      field: "startDate",
      expected: expected.startDate,
      got: got.startDate,
      correct: dateWithin(expected.startDate, got.startDate, 7),
      critical: true,
    },
    {
      field: "nationalities",
      expected: expected.nationalities,
      got: got.nationalities,
      correct: sameSet(expected.nationalities, got.nationalities),
      critical: true,
    },
    {
      field: "budgetPpUsd",
      expected: expected.budgetPpUsd,
      got: got.budgetPpUsd,
      correct: expected.budgetPpUsd === got.budgetPpUsd,
      critical: false,
    },
    { field: "fitness", expected: expected.fitness, got: got.fitness, correct: expected.fitness === got.fitness, critical: false },
    {
      field: "hasChildren",
      expected: expected.hasChildren,
      got: got.hasChildren,
      correct: expected.hasChildren === got.hasChildren,
      critical: true,
    },
    {
      field: "missingFields",
      expected: expected.missingFields,
      got: got.missingFields,
      correct: sameSet(expected.missingFields, got.missingFields),
      // Whether intake admits what it does not know is the whole point of the
      // stage. Inventing a nationality is worse than reporting it absent.
      critical: true,
    },
  ];
}

async function main(): Promise<void> {
  const cases = loadCases();
  console.log(`\nmodel  ${currentModel()}`);
  console.log(`cases  ${cases.length}\n`);
  console.log("Measuring intake against the brief pinned on each case.");
  console.log("Pinned briefs are a human reading of the enquiry, not ground truth from");
  console.log("a real operator - they record what a careful person would extract.\n");

  const results: CaseResult[] = [];

  for (const c of cases) {
    process.stdout.write(`  ${c.id.padEnd(28)} `);
    const trajectory = new Trajectory();
    trajectory.start("wanderingyaks", currentModel(), { caseId: c.id, inquiry: c.inquiry });

    try {
      const got = await intake({ threadText: c.inquiry, today: c.today, trajectory });
      const fields = compare(c.brief, got);
      const critical = fields.filter((f) => f.critical);
      const result: CaseResult = {
        caseId: c.id,
        fields,
        criticalCorrect: critical.filter((f) => f.correct).length,
        criticalTotal: critical.length,
        allCorrect: fields.filter((f) => f.correct).length,
        allTotal: fields.length,
        costUsd: trajectory.totals.costUsd,
        latencyMs: trajectory.totals.latencyMs,
      };
      results.push(result);
      trajectory.end("scored");

      const missed = fields.filter((f) => !f.correct).map((f) => f.field);
      console.log(
        `critical ${result.criticalCorrect}/${result.criticalTotal}  all ${result.allCorrect}/${result.allTotal}` +
          (missed.length ? `  missed: ${missed.join(", ")}` : ""),
      );
    } catch (err) {
      const message = err instanceof LlmError ? err.message : (err as Error).message;
      console.log(`ERROR  ${message.slice(0, 70)}`);
      results.push({
        caseId: c.id,
        fields: [],
        criticalCorrect: 0,
        criticalTotal: 0,
        allCorrect: 0,
        allTotal: 0,
        costUsd: 0,
        latencyMs: 0,
        error: message,
      });
    }
  }

  const ok = results.filter((r) => r.error === undefined);
  const criticalCorrect = ok.reduce((a, r) => a + r.criticalCorrect, 0);
  const criticalTotal = ok.reduce((a, r) => a + r.criticalTotal, 0);
  const allCorrect = ok.reduce((a, r) => a + r.allCorrect, 0);
  const allTotal = ok.reduce((a, r) => a + r.allTotal, 0);

  // Which fields intake gets wrong is more useful than how often, because it
  // says what to change in the prompt.
  const byField = new Map<string, { correct: number; total: number }>();
  for (const r of ok) {
    for (const f of r.fields) {
      const entry = byField.get(f.field) ?? { correct: 0, total: 0 };
      entry.total += 1;
      if (f.correct) entry.correct += 1;
      byField.set(f.field, entry);
    }
  }

  const lines: string[] = [];
  lines.push("# Intake accuracy", "", `Generated ${new Date().toISOString()}`, "");
  lines.push(
    "Measures the brief intake extracts against the brief pinned on each case.",
    "Critical fields are the ones where being wrong makes a trip unrunnable or",
    "illegal rather than merely less well targeted.",
    "",
  );
  lines.push(`| | |`, `|---|---|`);
  lines.push(`| **Critical fields correct** | **${criticalCorrect}/${criticalTotal}** (${((criticalCorrect / Math.max(1, criticalTotal)) * 100).toFixed(0)}%) |`);
  lines.push(`| All fields correct | ${allCorrect}/${allTotal} (${((allCorrect / Math.max(1, allTotal)) * 100).toFixed(0)}%) |`);
  lines.push(`| Cases with every critical field right | ${ok.filter((r) => r.criticalCorrect === r.criticalTotal).length}/${ok.length} |`);
  lines.push(`| Runs that errored | ${results.length - ok.length} |`);
  lines.push(`| Cost | $${results.reduce((a, r) => a + r.costUsd, 0).toFixed(4)} |`);

  lines.push("", "## By field", "", "| Field | Correct | Critical |", "|---|---|---|");
  for (const [field, { correct, total }] of byField) {
    const critical = ok[0]?.fields.find((f) => f.field === field)?.critical ? "yes" : "";
    lines.push(`| ${field} | ${correct}/${total} | ${critical} |`);
  }

  lines.push("", "## Misreadings", "");
  const misses = ok.flatMap((r) => r.fields.filter((f) => !f.correct).map((f) => ({ caseId: r.caseId, ...f })));
  if (misses.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Case | Field | Expected | Got |", "|---|---|---|---|");
    for (const m of misses) {
      lines.push(`| ${m.caseId} | ${m.field} | \`${JSON.stringify(m.expected)}\` | \`${JSON.stringify(m.got)}\` |`);
    }
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const markdown = lines.join("\n") + "\n";
  writeFileSync(join(RESULTS_DIR, "intake-accuracy.md"), markdown, "utf8");
  writeFileSync(
    join(RESULTS_DIR, "intake-accuracy.json"),
    JSON.stringify({ model: currentModel(), at: new Date().toISOString(), results }, null, 2),
    "utf8",
  );

  console.log(`\ncritical fields  ${criticalCorrect}/${criticalTotal}`);
  console.log(`all fields       ${allCorrect}/${allTotal}`);
  console.log(`\nwritten to eval/results/intake-accuracy.md\n`);
}

main().catch((err) => {
  if (err instanceof LlmError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
