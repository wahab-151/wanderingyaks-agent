import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Brief } from "../src/schemas.js";

const here = dirname(fileURLToPath(import.meta.url));
const CASE_DIR = join(here, "cases");

/**
 * Evaluation cases are frozen JSON in git, so a result can be reproduced from
 * a clean clone. They are validated on load for the same reason the knowledge
 * base is: a malformed case that silently defaults would corrupt the numbers
 * the submission rests on.
 */

export const EvalCase = z.object({
  id: z.string(),
  /**
   * Synthetic or anonymised-real. Anything derived from a customer
   * conversation must be scrubbed before it reaches this directory.
   */
  provenance: z.enum(["synthetic", "anonymised-real"]),
  difficulty: z.enum(["easy", "moderate", "hard"]),
  inquiry: z.string().min(1),
  /** Pinned, so permit lead times do not drift as the calendar moves. */
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Pinned until intake exists; then this becomes intake's expected output. */
  brief: Brief,
  notes: z.string(),
  groundTruth: z.object({
    operatorItinerary: z.string().nullable(),
    quotedTotalUsd: z.number().nullable(),
    operatorMinutesSpent: z.number().nullable(),
  }),
});

export type EvalCase = z.infer<typeof EvalCase>;

export function loadCases(only?: string[]): EvalCase[] {
  const files = readdirSync(CASE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const cases = files.map((file) => {
    const path = join(CASE_DIR, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      throw new Error(`malformed JSON in eval case ${file}: ${(cause as Error).message}`);
    }

    const parsed = EvalCase.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new Error(`invalid eval case ${file}:\n${detail}`);
    }
    return parsed.data;
  });

  if (only && only.length > 0) {
    const wanted = new Set(only);
    const picked = cases.filter((c) => wanted.has(c.id));
    const missing = only.filter((id) => !cases.some((c) => c.id === id));
    if (missing.length > 0) {
      throw new Error(`no such eval case: ${missing.join(", ")}`);
    }
    return picked;
  }

  return cases;
}

/** True when no case carries a real operator itinerary to compare against. */
export function lacksGroundTruth(cases: EvalCase[]): boolean {
  return cases.every((c) => c.groundTruth.operatorItinerary === null);
}
