import "dotenv/config";
import { loadKb, KbError } from "./kb.js";
import { verify, hardViolations, isFeasible } from "./verify.js";
import { Trajectory } from "./trajectory.js";
import { currentModel, LlmError } from "./llm.js";
import { runBaseline, parseBaselineOutput } from "../baseline/one-shot.js";
import type { Brief } from "./schemas.js";

/**
 * Runs the baseline on one inquiry and scores it with the same verifier the
 * agent will be scored by.
 *
 *   npm run baseline -- "4 friends, 8 days in Skardu, late April, $900 each"
 *
 * The brief is passed as flags rather than parsed, because intake does not
 * exist yet and inferring it here with a second model call would quietly make
 * the baseline less naive than it claims to be.
 */

const DEFAULT_INQUIRY =
  "Hi, we're 4 friends looking to visit Skardu for about 8 days in late April. " +
  "Budget is around $900 each. We'd really love to see the Deosai plains. " +
  "We're all reasonably fit. Two of us are British, two Australian.";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const previousArg = (a: string) => process.argv[process.argv.indexOf(a) - 1] ?? "";
const inquiry = positional.filter((a) => !previousArg(a).startsWith("--")).join(" ") || DEFAULT_INQUIRY;

const brief: Brief = {
  groupSize: Number(flag("group", "4")),
  nights: Number(flag("nights", "7")),
  startDate: flag("start", "2026-04-18"),
  endDate: flag("end", "2026-04-25"),
  budgetPpUsd: Number(flag("budget", "900")),
  nationalities: flag("nationalities", "GB,AU").split(","),
  interests: ["mountains"],
  fitness: "moderate",
  hasChildren: false,
  notes: "brief supplied by flags; intake stage not yet built",
  missingFields: [],
};

async function main(): Promise<void> {
  const tenantId = process.env.TENANT_ID ?? "wanderingyaks";
  const kb = loadKb(tenantId);
  const model = currentModel();

  const trajectory = new Trajectory();
  trajectory.start(tenantId, model, { inquiry });

  console.log(`\nmodel      ${model}`);
  console.log(`tenant     ${kb.tenantName}`);
  console.log(`trajectory ${trajectory.path}`);
  console.log(`\ninquiry\n-------\n${inquiry}\n`);

  // --- 1. the baseline itself -------------------------------------------
  console.log("running baseline (one call, no knowledge base, no verifier)...\n");
  const prose = await runBaseline(inquiry, trajectory);
  console.log("baseline output\n---------------");
  console.log(prose);

  // --- 2. structure it so the verifier can read it -----------------------
  console.log("\nparsing to structured form for scoring...");
  const draft = await parseBaselineOutput(prose, kb, trajectory);
  trajectory.step("baseline-parse", `${draft.days.length} days parsed`);

  console.log(`\nparsed itinerary: ${draft.title}`);
  for (const d of draft.days) {
    const drive = d.driveSegments.length ? ` via ${d.driveSegments.join(", ")}` : "";
    console.log(`  day ${String(d.day).padStart(2)}  ${d.location.padEnd(18)} ${d.hotelId ?? "(no hotel)"}${drive}`);
  }

  // --- 3. score it -------------------------------------------------------
  const violations = verify({ brief, draft, kb, today: new Date().toISOString().slice(0, 10) });
  const hard = hardViolations(violations);
  trajectory.step("verify", `${hard.length} hard, ${violations.length - hard.length} soft`, {
    codes: violations.map((v) => v.code),
  });

  console.log(`\nverifier\n--------`);
  if (violations.length === 0) {
    console.log("  no violations");
  } else {
    for (const v of violations) {
      const where = v.day === 0 ? "trip" : `day ${v.day}`;
      console.log(`  ${v.severity === "hard" ? "x" : "!"} [${v.code}] ${where}: ${v.detail}`);
    }
  }

  const outcome = isFeasible(violations) ? "sendable" : "blocked";
  trajectory.end(outcome);

  const { costUsd, latencyMs, llmCalls } = trajectory.totals;
  console.log(`\n  ${hard.length} hard, ${violations.length - hard.length} soft -> ${outcome.toUpperCase()}`);
  console.log(`\ncost       $${costUsd.toFixed(4)} across ${llmCalls} model calls`);
  console.log(`latency    ${(latencyMs / 1000).toFixed(1)}s`);
  console.log(`trajectory ${trajectory.path}\n`);
}

main().catch((err) => {
  if (err instanceof KbError || err instanceof LlmError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
