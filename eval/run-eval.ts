import "dotenv/config";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKb, KbError } from "../src/kb.js";
import { verify } from "../src/verify.js";
import { Trajectory } from "../src/trajectory.js";
import { currentModel, LlmError } from "../src/llm.js";
import { runBaseline, parseBaselineOutput } from "../baseline/one-shot.js";
import { runAgent } from "../src/run.js";
import { loadCases, lacksGroundTruth, type EvalCase } from "./load-cases.js";
import { scoreCase, summarise, renderMarkdown, type CaseScore } from "./score.js";
import type { DraftItinerary } from "../src/schemas.js";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(here, "results");

/**
 * Runs every evaluation case through each system and writes the results to
 * eval/results/ as both markdown and raw JSON.
 *
 *   npm run eval                    all cases, all systems
 *   npm run eval -- --case case-01  one case
 *   npm run eval -- --system agent  one system
 *
 * The results are committed. They are the evidence behind every number in the
 * README, and a claim whose evidence is not in the repository is not a claim.
 *
 * A case that throws is recorded as a failed run rather than aborting the
 * sweep. Losing eleven good results because the twelfth timed out is worse
 * than reporting one error honestly.
 */

type SystemName = "baseline" | "agent" | "agent-norepair";

interface RunResult {
  draft: DraftItinerary;
  costUsd: number;
  latencyMs: number;
  llmCalls: number;
  trajectoryPath: string;
  repairAttempts?: number;
}

function flagList(name: string): string[] {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string).split(",") : [];
}

async function runBaselineSystem(c: EvalCase, kb: ReturnType<typeof loadKb>): Promise<RunResult> {
  const trajectory = new Trajectory();
  trajectory.start(kb.tenantId, currentModel(), { caseId: c.id, inquiry: c.inquiry });

  const prose = await runBaseline(c.inquiry, trajectory);
  const draft = await parseBaselineOutput(prose, kb, trajectory);
  trajectory.step("baseline-parse", `${draft.days.length} days parsed`);

  const totals = trajectory.totals;
  trajectory.end("scored");
  return { draft, ...{ costUsd: totals.costUsd, latencyMs: totals.latencyMs, llmCalls: totals.llmCalls }, trajectoryPath: trajectory.path };
}

/**
 * The agent runs the whole pipeline from the raw inquiry, intake included, so
 * that it and the baseline are given exactly the same input and the same job.
 * The pinned `brief` on each case is deliberately not used here - handing the
 * agent a pre-parsed brief the baseline has to infer for itself would be a
 * quiet advantage, and the comparison has to be defensible.
 *
 * `agent-norepair` is the same pipeline with the repair loop switched off. It
 * exists to answer whether the loop earns its place, rather than assuming it.
 */
async function runAgentSystem(
  c: EvalCase,
  kb: ReturnType<typeof loadKb>,
  maxRepairAttempts: number,
): Promise<RunResult> {
  const trajectory = new Trajectory();
  trajectory.start(kb.tenantId, currentModel(), { caseId: c.id, inquiry: c.inquiry });

  const result = await runAgent({
    inquiry: c.inquiry,
    today: c.today,
    kb,
    trajectory,
    maxRepairAttempts,
    // The customer letter costs a call and is not scored by the verifier.
    skipRender: true,
  });

  const totals = trajectory.totals;
  trajectory.end("scored");
  return {
    draft: result.draft,
    costUsd: totals.costUsd,
    latencyMs: totals.latencyMs,
    llmCalls: totals.llmCalls,
    trajectoryPath: trajectory.path,
    repairAttempts: result.repairAttempts,
  };
}

const RUNNERS: Record<SystemName, (c: EvalCase, kb: ReturnType<typeof loadKb>) => Promise<RunResult>> = {
  baseline: runBaselineSystem,
  agent: (c, kb) => runAgentSystem(c, kb, 3),
  "agent-norepair": (c, kb) => runAgentSystem(c, kb, 0),
};

async function main(): Promise<void> {
  const tenantId = flagList("tenant")[0] ?? process.env.TENANT_ID ?? "wanderingyaks";
  const kb = loadKb(tenantId);
  const cases = loadCases(flagList("case"));

  const requested = flagList("system") as SystemName[];
  const systems = requested.length > 0 ? requested : (Object.keys(RUNNERS) as SystemName[]);

  const unknown = systems.filter((s) => !(s in RUNNERS));
  if (unknown.length > 0) {
    console.error(`no such system: ${unknown.join(", ")}. Known: ${Object.keys(RUNNERS).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nmodel    ${currentModel()}`);
  console.log(`tenant   ${kb.tenantName}`);
  console.log(`cases    ${cases.length}`);
  console.log(`systems  ${systems.join(", ")}`);

  if (kb.hasUnverifiedData) {
    console.log(`\nWARNING  the knowledge base still holds placeholder data`);
    console.log(`         (${kb.unverifiedFiles.length} files). No cost figure below is real.`);
  }
  if (lacksGroundTruth(cases)) {
    console.log(`\nWARNING  no case carries a real operator itinerary, so price accuracy`);
    console.log(`         and minutes-saved cannot be reported. See docs/KB-SOURCES.md.`);
  }
  console.log();

  const scores: CaseScore[] = [];

  for (const c of cases) {
    for (const system of systems) {
      const runner = RUNNERS[system]!;
      process.stdout.write(`  ${c.id.padEnd(24)} ${system.padEnd(9)} `);

      try {
        const result = await runner(c, kb);
        const violations = verify({
          brief: c.brief,
          draft: result.draft,
          kb,
          today: c.today,
        });

        const score = scoreCase({
          caseId: c.id,
          system,
          draft: result.draft,
          violations,
          kb,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          llmCalls: result.llmCalls,
          ...(result.repairAttempts === undefined ? {} : { repairAttempts: result.repairAttempts }),
        });
        scores.push(score);

        console.log(
          `feas ${score.hardByFamily.feasibility}  ground ${score.hardByFamily.grounding}  ` +
            `fid ${score.hardByFamily.fidelity}  ` +
            `checkable ${score.scoreability.feasibilityCheckedDays}/${score.scoreability.totalDays}  ` +
            `repairs ${score.repairAttempts ?? "-"}  ` +
            `$${score.costUsd.toFixed(4)}`,
        );
      } catch (err) {
        const message = err instanceof LlmError ? err.message : (err as Error).message;
        console.log(`ERROR  ${message.slice(0, 90)}`);
        scores.push({
          caseId: c.id,
          system,
          hard: 0,
          soft: 0,
          byFamily: { grounding: 0, feasibility: 0, fidelity: 0, advisory: 0 },
          hardByFamily: { grounding: 0, feasibility: 0, fidelity: 0, advisory: 0 },
          codes: [],
          scoreability: { totalDays: 0, feasibilityCheckedDays: 0, unknownLocations: [] },
          sendable: false,
          costUsd: 0,
          latencyMs: 0,
          llmCalls: 0,
          error: message,
        });
      }
    }
  }

  const summaries = systems.map((s) => summarise(s, scores.filter((x) => x.system === s)));

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const markdown = renderMarkdown(summaries, scores);
  writeFileSync(join(RESULTS_DIR, "latest.md"), markdown, "utf8");
  writeFileSync(join(RESULTS_DIR, `${stamp}.md`), markdown, "utf8");
  writeFileSync(
    join(RESULTS_DIR, "latest.json"),
    JSON.stringify({ model: currentModel(), tenantId, at: new Date().toISOString(), summaries, scores }, null, 2),
    "utf8",
  );

  console.log(`\n${markdown.split("## Per case")[0]?.trimEnd() ?? ""}`);
  console.log(`\nwritten to eval/results/latest.md and latest.json\n`);
}

main().catch((err) => {
  if (err instanceof KbError || err instanceof LlmError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
