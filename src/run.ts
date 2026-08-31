import { retrieve } from "./retrieve.js";
import { route, type RouteDecision } from "./router.js";
import { verify, hardViolations, isFeasible, DEFAULT_HELD_OUT } from "./verify.js";
import { price, renderCostSheet, PriceError } from "./price.js";
import { intake, compose, repair, render } from "./stages.js";
import type { KB } from "./kb.js";
import type { Trajectory } from "./trajectory.js";
import type { Brief, CostSheet, DraftItinerary, Violation } from "./schemas.js";

/**
 * One inquiry, end to end.
 *
 *   normalise -> intake (LLM) -> retrieve (code) -> compose (LLM)
 *             -> verify (code) <-> repair (LLM), capped
 *             -> price (code) -> render (LLM) -> operator review
 *
 * Nothing here sends anything. The proposal is produced and handed to a human;
 * transmission is a separate, gated action.
 */

export interface AgentResult {
  brief: Brief;
  draft: DraftItinerary;
  costSheet: CostSheet | null;
  violations: Violation[];
  proposal: string | null;
  costSheetText: string | null;
  repairAttempts: number;
  /** Violations still present after the repair loop gave up. */
  unresolved: Violation[];
  priceError: string | null;
  /** Whether the catalogue already answered this enquiry. */
  routing: RouteDecision;
}

export interface RunOptions {
  inquiry: string;
  today: string;
  kb: KB;
  trajectory: Trajectory;
  /**
   * Pinned brief, used by the evaluation so that a change in compose is not
   * confounded by a change in how intake read the same enquiry. Omitted in
   * normal operation, where intake does the work.
   */
  brief?: Brief;
  /** 0 disables repair entirely, which is how the loop earns its place. */
  maxRepairAttempts?: number;
  /** Skip the customer letter when only the structured result is wanted. */
  skipRender?: boolean;
}

export async function runAgent(opts: RunOptions): Promise<AgentResult> {
  const { kb, trajectory, today } = opts;
  const maxRepairAttempts = opts.maxRepairAttempts ?? 3;

  // --- 1. intake ----------------------------------------------------------
  const brief =
    opts.brief ??
    (await intake({ threadText: opts.inquiry, today, trajectory }));

  if (opts.brief) {
    trajectory.step("intake", "skipped: brief pinned by the evaluation case");
  } else {
    trajectory.step(
      "intake",
      `${brief.groupSize} pax, ${brief.nights} nights from ${brief.startDate ?? "no date"}` +
        (brief.missingFields.length ? `, missing: ${brief.missingFields.join(", ")}` : ""),
    );
  }

  // --- 2. route -----------------------------------------------------------
  // Asked before composing: if the published catalogue already answers this
  // enquiry, the customer is better served by a trip that has been run before.
  // The recommendation is surfaced to the operator rather than short-circuiting
  // the pipeline, so they can see both options and pick.
  const routing = route(brief, kb);
  trajectory.step("router", routing.rationale, {
    action: routing.action,
    candidates: routing.candidates.slice(0, 3).map((c) => ({ id: c.pkg.id, score: c.score })),
  });

  // --- 3. retrieve --------------------------------------------------------
  const retrieved = retrieve(brief, kb, today);
  const closed = retrieved.locations.filter((l) => l.availability === "closed");
  trajectory.step(
    "retrieve",
    `${retrieved.locations.length} locations, ${closed.length} closed for these dates, ` +
      `${retrieved.routes.length} segments, ${retrieved.transport.length} suitable vehicles`,
    { closed: closed.map((l) => l.id), notes: retrieved.notes },
  );

  // --- 4. compose ---------------------------------------------------------
  let draft = await compose({ brief, retrieved, trajectory });

  // --- 5. verify <-> repair ----------------------------------------------
  // The repair loop sees a reduced violation list. DEFAULT_HELD_OUT is
  // withheld so that the evaluation can report violations the agent avoided
  // without ever being told about them. The operator still sees everything.
  let violations = verify({ brief, draft, kb, today });
  let repairAttempts = 0;

  trajectory.step("verify", summarise(violations), { codes: violations.map((v) => v.code) });

  while (repairAttempts < maxRepairAttempts) {
    const visible = verify({ brief, draft, kb, today }, { exclude: DEFAULT_HELD_OUT });
    const blocking = hardViolations(visible);
    if (blocking.length === 0) break;

    repairAttempts += 1;
    draft = await repair({
      brief,
      draft,
      violations: blocking,
      retrieved,
      attempt: repairAttempts,
      trajectory,
    });

    violations = verify({ brief, draft, kb, today });
    trajectory.step(
      "verify",
      `after repair ${repairAttempts}: ${summarise(violations)}`,
      { codes: violations.map((v) => v.code) },
    );
  }

  violations = verify({ brief, draft, kb, today });

  // --- 6. price -----------------------------------------------------------
  let costSheet: CostSheet | null = null;
  let priceError: string | null = null;
  try {
    costSheet = price({ draft, brief, kb });
    trajectory.step(
      "price",
      `$${costSheet.perPersonUsd.toFixed(0)}pp, $${costSheet.totalUsd.toFixed(0)} total, ` +
        `${(costSheet.marginPct * 100).toFixed(0)}% margin`,
      { subtotalUsd: costSheet.subtotalUsd, totalUsd: costSheet.totalUsd },
    );
    // Re-run with costs so the budget check can fire.
    violations = verify({ brief, draft, kb, costSheet, today });
  } catch (err) {
    if (!(err instanceof PriceError)) throw err;
    priceError = err.message;
    trajectory.step("price", `refused: ${err.message}`);
  }

  // --- 7. render ----------------------------------------------------------
  let proposal: string | null = null;
  if (!opts.skipRender && costSheet) {
    proposal = await render({ brief, draft, costSheet, violations, kb, trajectory });
  }

  const unresolved = hardViolations(violations);
  return {
    brief,
    draft,
    costSheet,
    violations,
    proposal,
    costSheetText: costSheet ? renderCostSheet(costSheet, brief, kb.currency) : null,
    repairAttempts,
    unresolved,
    priceError,
    routing,
  };
}

function summarise(violations: Violation[]): string {
  const hard = hardViolations(violations).length;
  return `${hard} hard, ${violations.length - hard} soft` + (isFeasible(violations) ? " (feasible)" : "");
}
