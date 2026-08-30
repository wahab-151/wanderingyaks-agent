import { loadKb, KbError, type KB } from "./kb.js";
import { verify, hardViolations, isFeasible } from "./verify.js";
import type { Brief, DraftItinerary, Violation } from "./schemas.js";

/**
 * Health check for a tenant knowledge base, plus a few worked itineraries run
 * through the real verifier.
 *
 * Run with: npm run kb:check [tenantId]
 *
 * This is a reading tool, not a test. The unit tests assert; this shows an
 * operator what the knowledge base currently believes, so that a wrong season
 * window or drive time is visible before it reaches a customer.
 */

const tenantId = process.argv[2] ?? process.env.TENANT_ID ?? "wanderingyaks";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function formatViolation(v: Violation): string {
  const where = v.day === 0 ? "trip" : `day ${v.day}`;
  const mark = v.severity === "hard" ? "x" : "!";
  return `  ${mark} [${v.code}] ${where}: ${v.detail}`;
}

let kb: KB;
try {
  kb = loadKb(tenantId);
} catch (err) {
  if (err instanceof KbError) {
    console.error(`\nKnowledge base failed to load.\n\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// 1. What is loaded
// ---------------------------------------------------------------------------

heading(`Knowledge base: ${kb.tenantName} (${kb.tenantId})`);
console.log(`  locations       ${kb.locations().length}`);
console.log(`  road segments   ${kb.routes().length}`);
console.log(`  hotels          ${kb.hotels().length}`);
console.log(`  vehicles        ${kb.transport().length}`);
console.log(`  packages        ${kb.packages().length}`);
console.log(`  currency        ${kb.currency}`);

heading("Operating policy");
console.log(`  max driving per day     ${kb.policy.maxDriveHoursPerDay} h`);
console.log(`  altitude rule applies   above ${kb.policy.altitudeRuleAboveM} m`);
console.log(`  max sleeping gain/day   ${kb.policy.maxSleepGainPerDayM} m`);
console.log(`  margin                  ${(kb.policy.marginPct * 100).toFixed(0)} %`);
console.log(`  budget tolerance        ${(kb.policy.budgetTolerancePct * 100).toFixed(0)} %`);

// ---------------------------------------------------------------------------
// 2. Season grid - the file this check exists to make legible
// ---------------------------------------------------------------------------

heading("Seasonal access by month (sampled on the 15th)");
console.log(`  ${"location".padEnd(16)}${MONTHS.map((m) => m.slice(0, 1).padStart(3)).join("")}   window`);

const seasonal = kb
  .locations()
  .filter((loc) => {
    const s = kb.season(loc.id);
    return s !== null && !(s.opens === "01-01" && s.closes === "12-31");
  })
  .sort((a, b) => b.elevationM - a.elevationM);

for (const loc of seasonal) {
  const season = kb.season(loc.id)!;
  const grid = MONTHS.map((_, i) => {
    const month = String(i + 1).padStart(2, "0");
    return (kb.isOpen(loc.id, `2026-${month}-15`) ? "#" : ".").padStart(3);
  }).join("");
  console.log(`  ${loc.id.padEnd(16)}${grid}   ${season.opens} to ${season.closes}`);
}

const yearRound = kb.locations().length - seasonal.length;
console.log(`\n  # open   . closed`);
console.log(`  ${yearRound} further locations are open year round.`);

// ---------------------------------------------------------------------------
// 3. Worked itineraries through the real verifier
// ---------------------------------------------------------------------------

const baseBrief: Brief = {
  groupSize: 4,
  nights: 7,
  startDate: "2026-04-18",
  endDate: "2026-04-25",
  budgetPpUsd: 900,
  nationalities: ["GB"],
  interests: ["mountains", "photography"],
  fitness: "moderate",
  hasChildren: false,
  notes: "",
  missingFields: [],
};

/**
 * What a general-purpose model produces for "4 friends, 8 days in Skardu, late
 * April, around $900 each, we want to see Deosai". Fluent, confident, and
 * unrunnable: the plains are under snow until mid-June, and the sleeping
 * elevation jumps 1800 m in a single day.
 *
 * The Deosai permit is not a problem here - booking is three weeks out and the
 * zone needs three days notice. Move TODAY to within three days of day 4 and a
 * PERMIT_MISSING violation appears alongside the others.
 */
const plausibleButWrong: DraftItinerary = {
  title: "Skardu and the Deosai Plains, 8 days",
  days: [
    { day: 1, location: "islamabad", activity: "Arrive, transfer to hotel", hotelId: "islamabad_standard", driveSegments: [], isRestDay: true },
    { day: 2, location: "skardu", activity: "Fly to Skardu, Katpana desert", hotelId: "skardu_midrange", driveSegments: [], isRestDay: false },
    { day: 3, location: "shigar", activity: "Shigar Fort and valley", hotelId: "skardu_serena", driveSegments: ["skardu>shigar"], isRestDay: false },
    { day: 4, location: "deosai", activity: "Cross the Deosai Plains, camp by Sheosar Lake", hotelId: "deosai_camp", driveSegments: ["skardu>deosai"], isRestDay: false },
    { day: 5, location: "skardu", activity: "Return to Skardu", hotelId: "skardu_midrange", driveSegments: ["deosai>skardu"], isRestDay: false },
    { day: 6, location: "khaplu", activity: "Khaplu Palace and old town", hotelId: "khaplu_palace", driveSegments: ["skardu>khaplu"], isRestDay: false },
    { day: 7, location: "kachura", activity: "Upper Kachura lake, free afternoon", hotelId: "shangrila_kachura", driveSegments: ["khaplu>skardu", "skardu>kachura"], isRestDay: true },
    { day: 8, location: "islamabad", activity: "Fly out", hotelId: null, driveSegments: [], isRestDay: false },
  ],
  assumptions: ["Deosai accessible in late April", "Domestic flights operating"],
};

/** The same request, rerouted the way an operator would actually answer it. */
const operatorAnswer: DraftItinerary = {
  ...plausibleButWrong,
  title: "Skardu and Baltistan, 8 days",
  days: plausibleButWrong.days.map((d) =>
    d.day === 4
      ? { ...d, location: "khaplu", activity: "Khaplu Palace and the Shyok valley", hotelId: "khaplu_guesthouse", driveSegments: ["shigar>khaplu"] }
      : d.day === 5
        ? { ...d, location: "skardu", activity: "Kharpocho Fort and the bazaar", hotelId: "skardu_midrange", driveSegments: ["khaplu>skardu"] }
        : d.day === 6
          ? { ...d, location: "skardu", activity: "Manthal Buddha Rock, Katpana", hotelId: "skardu_midrange", driveSegments: [] }
          : d,
  ),
  assumptions: ["Deosai substituted with Khaplu: the plains are snowbound in April"],
};

const TODAY = "2026-04-01";

function report(label: string, draft: DraftItinerary, brief: Brief): void {
  heading(label);
  const violations = verify({ brief, draft, kb, today: TODAY });
  const hard = hardViolations(violations);

  if (violations.length === 0) {
    console.log("  no violations - this itinerary can be run as written");
  } else {
    violations.forEach((v) => console.log(formatViolation(v)));
  }
  console.log(
    `\n  ${hard.length} hard, ${violations.length - hard.length} soft -> ${
      isFeasible(violations) ? "SENDABLE" : "BLOCKED"
    }`,
  );
}

report("Itinerary A: what a general model writes (April, includes Deosai)", plausibleButWrong, baseBrief);
report("Itinerary B: the same request, rerouted", operatorAnswer, baseBrief);
report("Itinerary A again, moved to July", plausibleButWrong, {
  ...baseBrief,
  startDate: "2026-07-18",
  endDate: "2026-07-25",
});

// ---------------------------------------------------------------------------
// 4. Data provenance
// ---------------------------------------------------------------------------

if (kb.hasUnverifiedData) {
  heading("Unverified data");
  console.log("  These files still carry placeholder values. See docs/KB-SOURCES.md.\n");
  for (const file of kb.unverifiedFiles) {
    console.log(`  - ${file.replace(/\\/g, "/").split("/kb/")[1] ?? file}`);
  }
  console.log("\n  No quote produced from this knowledge base is real.");
}

console.log();
