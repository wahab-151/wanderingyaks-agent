import type { KB } from "./kb.js";
import type { Brief, Package } from "./schemas.js";

/**
 * Decides whether an enquiry is already answered by something in the published
 * catalogue. Pure code; no model call.
 *
 * The point is not cost saving, it is consistency. If an operator sells a
 * ten-day Hunza tour and someone asks for a ten-day Hunza tour, they should be
 * offered the trip that has been run before - with known suppliers, a known
 * price and a page on the website - rather than a bespoke one the agent
 * invented that happens to look similar.
 *
 * A recommendation is only made when the fit is clear. A near miss dressed up
 * as a match is worse than composing, because the customer receives something
 * that does not answer what they asked.
 */

export interface PackageMatch {
  pkg: Package;
  /** 0 to 1. See WEIGHTS for what it is made of. */
  score: number;
  reasons: string[];
  gaps: string[];
}

export interface RouteDecision {
  action: "recommend" | "compose";
  match: PackageMatch | null;
  candidates: PackageMatch[];
  /** Why this decision was made, for the trajectory and the operator. */
  rationale: string;
}

/**
 * Weights, and the threshold below, are untuned. They were set by judgement
 * rather than measurement because no real enquiry/package pairs exist yet to
 * tune against - see docs/KB-SOURCES.md. Tuning them against real cases is a
 * changelog entry waiting to be written.
 */
const WEIGHTS = {
  nights: 0.3,
  locations: 0.25,
  month: 0.2,
  fitness: 0.15,
  budget: 0.1,
} as const;

/**
 * Deliberately high. The cost of a false match - sending someone a trip that
 * does not answer their enquiry - is much higher than the cost of composing
 * something bespoke that turns out to resemble a package.
 */
export const RECOMMEND_THRESHOLD = 0.75;

const FITNESS_RANK = { low: 0, moderate: 1, high: 2 } as const;

function scoreNights(brief: Brief, pkg: Package): number {
  const diff = Math.abs(pkg.nights - brief.nights);
  if (diff === 0) return 1;
  if (diff === 1) return 0.8;
  if (diff === 2) return 0.5;
  // Three nights out on a week-long trip is a different holiday.
  return 0;
}

function scoreLocations(brief: Brief, pkg: Package): number {
  // The brief has no location field: what the customer named lives in
  // `interests` and `notes` as free text. Matching on substrings is crude but
  // honest about what is available, and it never invents a match.
  const wanted = [...brief.interests, brief.notes].join(" ").toLowerCase();
  if (wanted.trim() === "") return 0.5; // nothing stated: neither match nor mismatch

  const named = pkg.locations.filter((loc) => wanted.includes(loc.replace(/_/g, " ")));
  if (named.length === 0) return 0.3;
  return Math.min(1, 0.5 + named.length * 0.25);
}

function scoreMonth(brief: Brief, pkg: Package): number {
  if (brief.startDate === null) return 0.5;
  const month = Number(brief.startDate.slice(5, 7));
  return pkg.bestMonths.includes(month) ? 1 : 0;
}

function scoreFitness(brief: Brief, pkg: Package): number {
  const asked = FITNESS_RANK[brief.fitness];
  const needed = FITNESS_RANK[pkg.fitness];
  if (needed === asked) return 1;
  // A fitter group can do an easier trip; the reverse is a safety problem.
  if (needed < asked) return 0.7;
  return 0;
}

function scoreBudget(brief: Brief, pkg: Package): number {
  if (brief.budgetPpUsd === null) return 0.5;
  if (pkg.fromUsd <= brief.budgetPpUsd) return 1;
  const over = (pkg.fromUsd - brief.budgetPpUsd) / brief.budgetPpUsd;
  return over <= 0.1 ? 0.6 : 0;
}

export function scorePackage(brief: Brief, pkg: Package): PackageMatch {
  const parts = {
    nights: scoreNights(brief, pkg),
    locations: scoreLocations(brief, pkg),
    month: scoreMonth(brief, pkg),
    fitness: scoreFitness(brief, pkg),
    budget: scoreBudget(brief, pkg),
  };

  const score = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce(
    (sum, key) => sum + parts[key] * WEIGHTS[key],
    0,
  );

  const reasons: string[] = [];
  const gaps: string[] = [];

  const note = (ok: boolean, text: string) => (ok ? reasons : gaps).push(text);
  note(parts.nights >= 0.8, `${pkg.nights} nights against ${brief.nights} requested`);
  note(parts.month === 1, brief.startDate ? `runs in month ${Number(brief.startDate.slice(5, 7))}` : "no dates given");
  note(parts.fitness >= 0.7, `${pkg.fitness} fitness against ${brief.fitness} requested`);
  note(parts.budget >= 0.6, `from $${pkg.fromUsd} against $${brief.budgetPpUsd ?? "no"} budget`);

  return { pkg, score: Math.round(score * 100) / 100, reasons, gaps };
}

export function route(brief: Brief, kb: KB): RouteDecision {
  const candidates = kb
    .packages()
    .map((pkg) => scorePackage(brief, pkg))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0] ?? null;

  if (best === null) {
    return { action: "compose", match: null, candidates, rationale: "the catalogue is empty" };
  }

  if (best.score >= RECOMMEND_THRESHOLD) {
    return {
      action: "recommend",
      match: best,
      candidates,
      rationale: `"${best.pkg.title}" scores ${best.score} against a ${RECOMMEND_THRESHOLD} threshold`,
    };
  }

  return {
    action: "compose",
    match: null,
    candidates,
    rationale:
      `best catalogue match is "${best.pkg.title}" at ${best.score}, under the ` +
      `${RECOMMEND_THRESHOLD} threshold` +
      (best.gaps.length ? ` (${best.gaps.join("; ")})` : ""),
  };
}
