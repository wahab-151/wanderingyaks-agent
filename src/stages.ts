import { structured, text } from "./llm.js";
import { loadPrompt } from "./prompts.js";
import { Brief, DraftItinerary, type CostSheet, type Violation } from "./schemas.js";
import { renderForPrompt, type Retrieved } from "./retrieve.js";
import type { Trajectory } from "./trajectory.js";
import type { KB } from "./kb.js";

/**
 * The stages that call the model: intake, compose, repair, render.
 *
 * Each one is a prompt file plus a schema plus a call. Deliberately thin - all
 * the logic that has to be correct lives in retrieve, verify and price, none of
 * which appear here.
 */

export async function intake(args: {
  threadText: string;
  today: string;
  trajectory: Trajectory;
}): Promise<Brief> {
  return structured({
    stage: "intake",
    schema: Brief,
    schemaName: "brief",
    system: loadPrompt("intake"),
    user: `The enquiry arrived on ${args.today}. Resolve any relative dates against that.\n\nEnquiry:\n\n${args.threadText}`,
    trajectory: args.trajectory,
  });
}

export async function compose(args: {
  brief: Brief;
  retrieved: Retrieved;
  trajectory: Trajectory;
}): Promise<DraftItinerary> {
  const { brief, retrieved } = args;

  return structured({
    stage: "compose",
    schema: DraftItinerary,
    schemaName: "draft_itinerary",
    system: loadPrompt("compose"),
    user: [
      "## The brief",
      "",
      `Group size: ${brief.groupSize}`,
      `Nights: ${brief.nights} (so ${brief.nights + 1} days)`,
      `Dates: ${brief.startDate ?? "not given"} to ${brief.endDate ?? "not given"}`,
      `Budget per person: ${brief.budgetPpUsd === null ? "not given" : `$${brief.budgetPpUsd}`}`,
      `Nationalities: ${brief.nationalities.join(", ") || "not given"}`,
      `Fitness: ${brief.fitness}`,
      `Children in the group: ${brief.hasChildren ? "yes" : "no"}`,
      `Interests: ${brief.interests.join(", ") || "none stated"}`,
      brief.notes ? `Notes from intake: ${brief.notes}` : "",
      brief.missingFields.length > 0
        ? `The customer did not state: ${brief.missingFields.join(", ")}. Do not invent these; note what you assumed.`
        : "",
      "",
      renderForPrompt(retrieved, brief),
    ]
      .filter(Boolean)
      .join("\n"),
    trajectory: args.trajectory,
  });
}

export async function repair(args: {
  brief: Brief;
  draft: DraftItinerary;
  violations: Violation[];
  retrieved: Retrieved;
  attempt: number;
  trajectory: Trajectory;
}): Promise<DraftItinerary> {
  const { draft, violations, retrieved, brief } = args;

  const violationList = violations
    .map((v) => `- [${v.code}] ${v.day === 0 ? "whole trip" : `day ${v.day}`}: ${v.detail}`)
    .join("\n");

  return structured({
    stage: "repair",
    schema: DraftItinerary,
    schemaName: "draft_itinerary",
    // The compose instructions are restated so the constraints are not assumed
    // to carry over from a previous turn - each call is independent.
    system: `${loadPrompt("compose")}\n\n---\n\n${loadPrompt("repair")}`,
    user: [
      "## Violations to fix",
      "",
      violationList,
      "",
      "## The itinerary to correct",
      "",
      JSON.stringify(draft, null, 2),
      "",
      `## The brief it must still satisfy`,
      "",
      `${brief.groupSize} travellers, ${brief.nights} nights (${brief.nights + 1} days), ` +
        `starting ${brief.startDate ?? "date not given"}, fitness ${brief.fitness}.`,
      "",
      renderForPrompt(retrieved, brief),
    ].join("\n"),
    trajectory: args.trajectory,
  });
}

export async function render(args: {
  brief: Brief;
  draft: DraftItinerary;
  costSheet: CostSheet;
  violations: Violation[];
  kb: KB;
  trajectory: Trajectory;
}): Promise<string> {
  const { brief, draft, costSheet, violations, kb } = args;

  const days = [...draft.days]
    .sort((a, b) => a.day - b.day)
    .map((d) => {
      const location = kb.location(d.location);
      const hotel = d.hotelId ? kb.hotel(d.hotelId) : null;
      const driveHours = d.driveSegments.reduce((sum, s) => sum + (kb.driveHours(s) ?? 0), 0);
      return [
        `Day ${d.day} - ${location?.name ?? d.location}${location ? ` (${location.elevationM}m)` : ""}`,
        `  Activity: ${d.activity}`,
        `  Sleeps: ${hotel ? hotel.name : "departure day, no accommodation"}`,
        `  Driving: ${driveHours > 0 ? `${driveHours.toFixed(1)}h` : "none"}`,
        d.isRestDay ? "  Rest day" : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  // Soft violations reach the customer letter as things to be honest about.
  // Hard ones should never get this far, but if the repair loop gave up they
  // are surfaced rather than papered over.
  const caveats = violations.length
    ? violations.map((v) => `- [${v.severity}] ${v.detail}`).join("\n")
    : "none";

  return text({
    stage: "render",
    system: loadPrompt("render"),
    user: [
      "## Who this is for",
      "",
      `${brief.groupSize} travellers, ${brief.nights} nights, starting ${brief.startDate ?? "dates to confirm"}.`,
      `Fitness: ${brief.fitness}. Interests: ${brief.interests.join(", ") || "not stated"}.`,
      brief.notes ? `Context from the enquiry: ${brief.notes}` : "",
      "",
      "## The settled plan",
      "",
      `Title: ${draft.title}`,
      "",
      days,
      "",
      "## What the planner assumed or substituted",
      "",
      draft.assumptions.length ? draft.assumptions.map((a) => `- ${a}`).join("\n") : "nothing recorded",
      "",
      "## Outstanding caveats to be honest about",
      "",
      caveats,
      "",
      "## The price - use exactly this figure",
      "",
      `$${costSheet.perPersonUsd.toFixed(0)} per person, based on ${brief.groupSize} travelling.`,
      `Total for the group: $${costSheet.totalUsd.toFixed(0)}.`,
      "",
      "Included: accommodation as listed, private vehicle and driver throughout,",
      "guide, and any park or permit fees shown in the plan.",
      "Not included: international or domestic flights, meals other than hotel",
      "breakfast, personal expenses, tips, travel insurance.",
    ]
      .filter(Boolean)
      .join("\n"),
    trajectory: args.trajectory,
    maxTokens: 16_000,
  });
}
