import type { KB } from "./kb.js";
import type { Brief, CostSheet, DraftItinerary, Violation, ViolationCode } from "./schemas.js";

/**
 * Deterministic feasibility checks. No model call reaches this file, and no
 * rule here depends on anything except the draft, the brief and the knowledge
 * base. That is what makes it usable as both the repair loop's oracle and the
 * evaluation's scorer.
 *
 * Day convention, matching how the operator's own catalog is written
 * ("15 Days / 14 Nights"): day 1 is arrival, day N is departure, and the trip
 * therefore contains N - 1 nights of accommodation.
 */

// ---------------------------------------------------------------------------
// Held-out rules
// ---------------------------------------------------------------------------

/**
 * Codes withheld from the automated repair loop.
 *
 * The problem this solves: if the agent loops until verify() is clean and then
 * the evaluation scores it with the same verify(), the headline number is
 * circular - the agent was optimised against its own judge. Withholding a
 * subset gives an honest generalisation signal: violations the agent avoided
 * without ever being told about them.
 *
 * Safety is not reduced. Held-out violations are still computed, still returned
 * by a full verify(), and still shown to the operator at the review gate. They
 * are only invisible to the automatic repair prompt.
 *
 * These two were chosen because avoiding them depends on the composer actually
 * using the grounding it was given - elevations and permit rules are in its
 * context - rather than on iterating against feedback.
 */
export const DEFAULT_HELD_OUT: readonly ViolationCode[] = ["ALTITUDE_GAIN", "PERMIT_MISSING"];

export interface VerifyInput {
  brief: Brief;
  draft: DraftItinerary;
  kb: KB;
  /** Supplied only once price.ts has run; enables the budget check. */
  costSheet?: CostSheet;
  /** Reference date for permit lead times. Pin this in eval cases. */
  today?: string;
}

export interface VerifyOptions {
  /** Codes to suppress. The repair loop passes DEFAULT_HELD_OUT. */
  exclude?: readonly ViolationCode[];
}

// ---------------------------------------------------------------------------
// Date helpers - UTC throughout, so a run in Karachi and a run in CI agree
// ---------------------------------------------------------------------------

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------

export function verify(input: VerifyInput, options: VerifyOptions = {}): Violation[] {
  const { brief, draft, kb, costSheet } = input;
  const today = input.today ?? todayIso();
  const excluded = new Set(options.exclude ?? []);
  const policy = kb.policy;

  const out: Violation[] = [];
  const add = (code: ViolationCode, day: number, detail: string, severity: "hard" | "soft") => {
    if (excluded.has(code)) return;
    out.push({ code, day, detail, severity });
  };

  const days = [...draft.days].sort((a, b) => a.day - b.day);
  const lastDayNumber = days.length;

  // --- whole-itinerary checks --------------------------------------------

  const nights = days.length - 1;
  if (nights !== brief.nights) {
    add(
      "NIGHTS_MISMATCH",
      0,
      `itinerary has ${days.length} days (${nights} nights) but the brief asks for ${brief.nights} nights`,
      "hard",
    );
  }

  const canCheckDates = brief.startDate !== null;
  if (!canCheckDates) {
    add(
      "UNVERIFIABLE_DATES",
      0,
      "brief has no start date, so seasonal closure and permit lead times could not be checked",
      "soft",
    );
  }

  // --- per-day checks -----------------------------------------------------

  let previousSleepElevation: number | null = null;

  for (const day of days) {
    const isFinalDay = day.day === lastDayNumber;
    const date = canCheckDates ? addDays(brief.startDate as string, day.day - 1) : null;

    // An unknown location suppresses only the checks that genuinely need to
    // know where the day is spent - closure, altitude, permits. Hotels and
    // road segments are still checked, because they are independent facts.
    //
    // Skipping the whole day here was the original behaviour and it hid real
    // failures: an itinerary routing through a snowbound valley under a name
    // the knowledge base did not recognise scored as a single grounding error
    // and was never season-checked at all. Feasibility must not be silently
    // waived just because the naming was wrong.
    const location = kb.location(day.location);
    if (!location) {
      add("UNKNOWN_LOCATION", day.day, `"${day.location}" is not a location in the knowledge base`, "hard");
    }

    // --- accommodation ---
    if (day.hotelId === null) {
      if (!isFinalDay) {
        // Camping is a real operating mode but the Day contract cannot express
        // it yet. Until it can, a missing hotel on a non-departure day is an
        // unbooked night, which is worse to ship than a false positive.
        add("NO_INVENTORY", day.day, `no accommodation booked for the night of day ${day.day}`, "hard");
      }
    } else {
      const hotel = kb.hotel(day.hotelId);
      if (!hotel) {
        add("NO_INVENTORY", day.day, `hotel "${day.hotelId}" is not in the operator inventory`, "hard");
      } else if (hotel.location !== day.location) {
        add(
          "NO_INVENTORY",
          day.day,
          `hotel "${hotel.id}" is in ${hotel.location}, but day ${day.day} is spent in ${day.location}`,
          "hard",
        );
      }
      if (location?.isDaytripOnly) {
        add("NO_INVENTORY", day.day, `${location.name} has no accommodation and cannot be a night stop`, "hard");
      }
    }

    // --- drive segments ---
    let driveHours = 0;
    for (const segmentId of day.driveSegments) {
      const route = kb.route(segmentId);
      if (!route) {
        add("UNKNOWN_SEGMENT", day.day, `no road segment "${segmentId}" exists in the knowledge base`, "hard");
        continue;
      }
      driveHours += route.driveHours;

      // A segment can start or end somewhere seasonally shut that is not where
      // the day is spent. The day's own location is checked separately below;
      // reporting it twice would put the same fact in front of the repair
      // prompt as two problems.
      if (date) {
        const [from, to] = segmentId.split(">") as [string, string];
        for (const endpoint of [from, to]) {
          if (endpoint === day.location) continue;
          if (kb.isOpen(endpoint, date) === false) {
            const season = kb.season(endpoint);
            const name = kb.location(endpoint)?.name ?? endpoint;
            add(
              "CLOSED",
              day.day,
              `day ${day.day} (${date}) routes through ${name}, which is closed outside ${season?.opens} to ${season?.closes}`,
              "hard",
            );
          }
        }
      }
    }

    if (driveHours > policy.maxDriveHoursPerDay) {
      add(
        "DRIVE_HOURS",
        day.day,
        `day ${day.day} totals ${driveHours.toFixed(1)}h of driving, over the ${policy.maxDriveHoursPerDay}h limit`,
        "hard",
      );
    }

    // --- seasonal closure of the day's own location ---
    if (location && date && kb.isOpen(day.location, date) === false) {
      const season = kb.season(day.location);
      add(
        "CLOSED",
        day.day,
        `${location.name} is closed on ${date} (open ${season?.opens} to ${season?.closes}${season?.note ? `; ${season.note}` : ""})`,
        "hard",
      );
    }

    // --- acclimatisation ---
    // Measured on sleeping elevation only. Crossing a high pass and descending
    // to sleep is not a gain, which is why day trips are excluded here.
    const sleepsHere = day.hotelId !== null || !isFinalDay;
    if (sleepsHere) {
      if (!location) {
        // Elevation unknown, so the chain is broken. Resetting rather than
        // carrying the last known height forward avoids inventing a gain
        // across the gap.
        previousSleepElevation = null;
      } else {
        const elevation = location.elevationM;
        if (
          previousSleepElevation !== null &&
          elevation > policy.altitudeRuleAboveM &&
          elevation - previousSleepElevation > policy.maxSleepGainPerDayM
        ) {
          add(
            "ALTITUDE_GAIN",
            day.day,
            `sleeping elevation rises ${elevation - previousSleepElevation}m to ${elevation}m at ${location.name}, over the ${policy.maxSleepGainPerDayM}m daily limit above ${policy.altitudeRuleAboveM}m`,
            "hard",
          );
        }
        previousSleepElevation = elevation;
      }
    }

    // --- permits ---
    // Whether the place is restricted is asked before who is travelling,
    // because an empty nationality list must produce a warning rather than
    // silently matching nobody and passing.
    const zone = kb.restrictedZone(day.location);
    if (zone) {
      if (brief.nationalities.length === 0) {
        add(
          "PERMIT_MISSING",
          day.day,
          `${zone.name} is a restricted zone but the brief lists no nationalities, so permit requirements cannot be checked`,
          "soft",
        );
      } else if (date) {
        const permit = kb.permitFor(day.location, brief.nationalities);
        const lead = daysBetween(today, date);
        if (permit && lead < permit.zone.leadTimeDays) {
          add(
            "PERMIT_MISSING",
            day.day,
            `${zone.name} needs ${zone.leadTimeDays} days notice for ${permit.appliesToNationalities.join(", ")}, but arrival is in ${lead} days`,
            "hard",
          );
        }
      }
    }
  }

  // --- nationality-level rules, independent of any single day -------------

  if (canCheckDates) {
    const start = brief.startDate as string;
    const lead = daysBetween(today, start);
    for (const nationality of brief.nationalities) {
      const rule = kb.nationalityRule(nationality);
      if (rule.nocRequired && lead < rule.leadTimeDays) {
        add(
          "PERMIT_MISSING",
          0,
          `${nationality} nationals need an NOC with ${rule.leadTimeDays} days notice, but the trip starts in ${lead} days${rule.note ? ` (${rule.note})` : ""}`,
          "hard",
        );
      }
    }
  }

  // --- budget -------------------------------------------------------------

  if (costSheet && brief.budgetPpUsd !== null) {
    const ceiling = brief.budgetPpUsd * (1 + policy.budgetTolerancePct);
    if (costSheet.perPersonUsd > ceiling) {
      add(
        "BUDGET_EXCEEDED",
        0,
        `quote is $${costSheet.perPersonUsd.toFixed(0)} per person against a stated budget of $${brief.budgetPpUsd.toFixed(0)}`,
        "soft",
      );
    }
  }

  return out;
}

/** Hard violations block; soft violations are surfaced to the operator. */
export function hardViolations(violations: Violation[]): Violation[] {
  return violations.filter((v) => v.severity === "hard");
}

export function isFeasible(violations: Violation[]): boolean {
  return hardViolations(violations).length === 0;
}
