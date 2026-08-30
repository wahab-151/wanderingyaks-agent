import { text, structured } from "../src/llm.js";
import { loadPrompt } from "../src/prompts.js";
import { DraftItinerary } from "../src/schemas.js";
import type { Trajectory } from "../src/trajectory.js";
import type { KB } from "../src/kb.js";

/**
 * The baseline: one model call, no knowledge base, no verifier, no repair.
 *
 * This is the reference point every later number is measured against, which is
 * why it is built before the agent rather than after. Written afterwards, a
 * baseline gets unconsciously weakened to flatter the result.
 *
 * It is deliberately naive but not a strawman. The prompt below is a competent
 * brief - it asks for structure, practical detail and honest pricing, which is
 * what a capable person would write if they sat down to do this in one shot.
 * What it lacks is the operator's inventory, the season windows, the road
 * network and the permit rules. That gap is the contribution being measured,
 * and the README states it plainly rather than hiding it.
 */

const BASELINE_SYSTEM = `
You are an experienced tour operator writing a custom itinerary for a client
travelling in Gilgit-Baltistan, Pakistan.

Write a day-by-day itinerary that answers the client's request. For each day
give the place, what they do, where they sleep, and the driving involved.
Finish with a price per person in USD and a short summary of what is included.

Be specific and practical. Name the hotels. Give real drive times. Account for
every day of the trip. Write the way an operator writes to a client, not the way
a brochure is written.
`.trim();

export async function runBaseline(
  rawInquiry: string,
  trajectory: Trajectory,
): Promise<string> {
  return text({
    stage: "baseline",
    system: BASELINE_SYSTEM,
    user: rawInquiry,
    trajectory,
    maxTokens: 4000,
  });
}

/**
 * Converts the baseline's prose into the same DraftItinerary shape the agent
 * produces, so both can be scored by the identical verifier.
 *
 * This is an LLM parse and the README says so. The risk it carries is that a
 * charitable parser flatters the baseline - reading "a comfortable hotel in
 * Skardu" as a real inventory id would hand it a grounding it never had. The
 * prompt is written to forbid exactly that, and the parse is deliberately given
 * the id lists only so it can recognise a genuine reference, never to pick the
 * nearest match. Spot-check a sample of parses when reporting results.
 */
export async function parseBaselineOutput(
  prose: string,
  kb: KB,
  trajectory: Trajectory,
): Promise<DraftItinerary> {
  const locationIds = kb.locations().map((l) => `${l.id} (${l.name})`).join("\n");
  const hotelIds = kb.hotels().map((h) => `${h.id} (${h.name}, ${h.location})`).join("\n");

  const system = `${loadPrompt("baseline-parse")}

### Location ids
${locationIds}

### Hotel ids
${hotelIds}`;

  return structured({
    stage: "baseline-parse",
    schema: DraftItinerary,
    system,
    user: `Transcribe this itinerary into structured data:\n\n${prose}`,
    trajectory,
  });
}
