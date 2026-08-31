import "dotenv/config";
import { loadKb, KbError } from "./kb.js";
import { Trajectory } from "./trajectory.js";
import { currentModel, LlmError } from "./llm.js";
import { runAgent } from "./run.js";
import { saveProposal } from "./review.js";

/**
 * Runs the full agent on one inquiry and prints what an operator would review.
 *
 *   npm run agent -- "4 friends, 8 days in Skardu late April, $900 each"
 *   npm run agent -- --repair 0        disable the repair loop
 *   npm run agent -- --today 2026-04-01
 *
 * Nothing is sent. The proposal is produced for review, and transmission is a
 * separate action behind a recorded human approval.
 */

const DEFAULT_INQUIRY =
  "Hi, we're 4 friends looking to visit Skardu for about 8 days in late April. " +
  "Budget is around $900 each. We'd really love to see the Deosai plains. " +
  "We're all reasonably fit. Two of us are British, two Australian.";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const args = process.argv.slice(2);
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a.startsWith("--")) i += 1; // skip this flag and its value
  else positional.push(a);
}
const inquiry = positional.join(" ") || DEFAULT_INQUIRY;

async function main(): Promise<void> {
  const tenantId = flag("tenant", process.env.TENANT_ID ?? "wanderingyaks");
  const kb = loadKb(tenantId);
  const today = flag("today", new Date().toISOString().slice(0, 10));
  const maxRepairAttempts = Number(flag("repair", "3"));

  const trajectory = new Trajectory();
  trajectory.start(tenantId, currentModel(), { inquiry });

  console.log(`\nmodel        ${currentModel()}`);
  console.log(`tenant       ${kb.tenantName}`);
  console.log(`today        ${today}`);
  console.log(`repair cap   ${maxRepairAttempts}`);
  console.log(`\ninquiry\n-------\n${inquiry}\n`);
  console.log("running pipeline...\n");

  const result = await runAgent({ inquiry, today, kb, trajectory, maxRepairAttempts });

  // --- did the catalogue already answer this? ----------------------------
  console.log(`router
------`);
  console.log(`  ${result.routing.action}: ${result.routing.rationale}`);
  if (result.routing.match) {
    console.log(`  consider offering the published trip instead of this bespoke one.`);
  }

  // --- what intake understood -------------------------------------------
  const b = result.brief;
  console.log("brief\n-----");
  console.log(`  ${b.groupSize} travellers, ${b.nights} nights, ${b.startDate ?? "no date"} to ${b.endDate ?? "?"}`);
  console.log(`  budget $${b.budgetPpUsd ?? "?"}pp | ${b.nationalities.join(", ") || "nationality unknown"} | fitness ${b.fitness}`);
  if (b.missingFields.length) console.log(`  not stated: ${b.missingFields.join(", ")}`);
  if (b.notes) console.log(`  notes: ${b.notes}`);

  // --- the plan ----------------------------------------------------------
  console.log(`\nitinerary: ${result.draft.title}\n${"-".repeat(11 + result.draft.title.length)}`);
  for (const d of [...result.draft.days].sort((x, y) => x.day - y.day)) {
    const loc = kb.location(d.location);
    const hotel = d.hotelId ? kb.hotel(d.hotelId) : null;
    const hours = d.driveSegments.reduce((s, seg) => s + (kb.driveHours(seg) ?? 0), 0);
    console.log(
      `  ${String(d.day).padStart(2)}  ${(loc?.name ?? d.location).padEnd(22)} ` +
        `${(hotel?.name ?? "-- departure --").padEnd(30)} ${hours > 0 ? `${hours.toFixed(1)}h` : "   -"}`,
    );
  }

  if (result.draft.assumptions.length) {
    console.log("\nassumptions the operator should check\n------------------------------------");
    for (const a of result.draft.assumptions) console.log(`  - ${a}`);
  }

  // --- verification ------------------------------------------------------
  console.log(`\nverifier (after ${result.repairAttempts} repair attempt${result.repairAttempts === 1 ? "" : "s"})`);
  console.log("-".repeat(40));
  if (result.violations.length === 0) {
    console.log("  no violations");
  } else {
    for (const v of result.violations) {
      const where = v.day === 0 ? "trip" : `day ${v.day}`;
      console.log(`  ${v.severity === "hard" ? "x" : "!"} [${v.code}] ${where}: ${v.detail}`);
    }
  }

  // --- money -------------------------------------------------------------
  if (result.costSheetText) {
    console.log(`\n${result.costSheetText}`);
  } else {
    console.log(`\npricing refused: ${result.priceError}`);
  }

  // --- the letter --------------------------------------------------------
  if (result.proposal) {
    console.log(`\n${"=".repeat(72)}\nCUSTOMER PROPOSAL\n${"=".repeat(72)}\n`);
    console.log(result.proposal);
  }

  // --- the gate ----------------------------------------------------------
  // The proposal is persisted for a human to review. Nothing is sent from
  // here; send() is a separate command that refuses without an approval.
  saveProposal({
    runId: trajectory.runId,
    tenantId,
    createdAt: new Date().toISOString(),
    status: "awaiting_review",
    inquiry,
    brief: result.brief,
    draft: result.draft,
    costSheet: result.costSheet,
    violations: result.violations,
    letter: result.proposal,
    costSheetText: result.costSheetText,
  });

  const sendable = result.unresolved.length === 0;
  trajectory.end(sendable ? "awaiting_review" : "blocked");

  const { costUsd, latencyMs, llmCalls } = trajectory.totals;
  console.log(`\n${"=".repeat(72)}`);
  console.log(
    sendable
      ? "STATUS  passes every check. AWAITING OPERATOR REVIEW - not sent."
      : `STATUS  ${result.unresolved.length} unresolved hard violation(s). Flagged for the operator.`,
  );
  console.log(`        Nothing has been transmitted. Sending requires recorded approval.`);
  console.log(`
  npm run review -- show ${trajectory.runId}`);
  console.log(`  npm run review -- approve ${trajectory.runId} --operator <your-id>`);
  console.log(`\ncost       $${costUsd.toFixed(4)} across ${llmCalls} model calls`);
  console.log(`latency    ${(latencyMs / 1000).toFixed(0)}s`);
  console.log(`trajectory ${trajectory.path}\n`);
}

main().catch((err) => {
  if (err instanceof KbError || err instanceof LlmError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
