import type { KB } from "./kb.js";
import type { Brief, Hotel, Transport } from "./schemas.js";

/**
 * Selects the slice of the knowledge base that is actually usable for one
 * brief. Pure code; no model call.
 *
 * This is the module that keeps the composer honest. Rather than describing the
 * whole catalogue and trusting the model to filter it, compose is handed only
 * what it is allowed to use: properties this operator holds, in places open on
 * the requested dates, with vehicles that seat the group. A hotel that is not
 * in this payload cannot be booked, because the composer never sees it.
 *
 * It also pre-computes the answers to questions a model reliably gets wrong -
 * whether a valley is open on a given date, which permits the group needs and
 * how much notice they take - so that compose is never in a position to guess.
 */

export interface LocationOffer {
  id: string;
  name: string;
  elevationM: number;
  /** Open for the whole requested window, closed throughout, or partly. */
  availability: "open" | "closed" | "partial";
  /** Human-readable window, included so the composer can explain a refusal. */
  season: string;
  closedNote: string | null;
  isDaytripOnly: boolean;
  hotels: Hotel[];
  permit: {
    name: string;
    appliesTo: string[];
    leadTimeDays: number;
    haveEnoughNotice: boolean;
  } | null;
}

export interface RouteOffer {
  id: string;
  driveHours: number;
  maxAltitudeM: number;
  roadQuality: string;
  requiresJeep: boolean;
}

export interface Retrieved {
  locations: LocationOffer[];
  routes: RouteOffer[];
  transport: Transport[];
  staffDayRates: { id: string; name: string; ratePerDayUsd: number; perGroup: boolean }[];
  /** Constraints repeated here so the compose prompt has one place to read. */
  policy: {
    maxDriveHoursPerDay: number;
    maxSleepGainPerDayM: number;
    altitudeRuleAboveM: number;
  };
  notes: string[];
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * Budget tiers are advisory rather than a hard filter. A group with a small
 * budget may still want one premium night, and removing the option entirely
 * would let the composer quietly drop a request it should have priced and
 * declined. The tier is labelled; the pricing stage does the arithmetic.
 */
function affordableTiers(brief: Brief): Set<string> {
  const perNight = brief.budgetPpUsd === null ? Infinity : brief.budgetPpUsd / Math.max(1, brief.nights);
  if (perNight < 40) return new Set(["budget", "basic"]);
  if (perNight < 90) return new Set(["budget", "basic", "standard"]);
  return new Set(["budget", "basic", "standard", "premium"]);
}

export function retrieve(brief: Brief, kb: KB, today: string): Retrieved {
  const notes: string[] = [];
  const tiers = affordableTiers(brief);

  // Dates spanned by the trip. Without a start date, seasonality cannot be
  // resolved at all, and saying so is better than assuming midsummer.
  const dates: string[] = [];
  if (brief.startDate) {
    for (let i = 0; i <= brief.nights; i++) dates.push(addDays(brief.startDate, i));
  } else {
    notes.push(
      "No start date was given, so seasonal closures could not be resolved. " +
        "Do not assume any location is open; say what the itinerary depends on.",
    );
  }

  const locations: LocationOffer[] = kb.locations().map((loc) => {
    const season = kb.season(loc.id);
    const openFlags = dates.map((d) => kb.isOpen(loc.id, d));
    const availability: LocationOffer["availability"] =
      dates.length === 0
        ? "open"
        : openFlags.every((o) => o === true)
          ? "open"
          : openFlags.every((o) => o === false)
            ? "closed"
            : "partial";

    const zone = kb.restrictedZone(loc.id);
    const permitReq = zone ? kb.permitFor(loc.id, brief.nationalities) : null;
    const arrival = brief.startDate ?? null;

    return {
      id: loc.id,
      name: loc.name,
      elevationM: loc.elevationM,
      availability,
      season: season ? `${season.opens} to ${season.closes}` : "unknown",
      closedNote: season?.note ?? null,
      isDaytripOnly: loc.isDaytripOnly,
      hotels: kb.hotelsAt(loc.id).filter((h) => tiers.has(h.tier)),
      permit: permitReq
        ? {
            name: permitReq.zone.name,
            appliesTo: permitReq.appliesToNationalities,
            leadTimeDays: permitReq.zone.leadTimeDays,
            haveEnoughNotice:
              arrival === null ? false : daysBetween(today, arrival) >= permitReq.zone.leadTimeDays,
          }
        : null,
    };
  });

  const closed = locations.filter((l) => l.availability === "closed");
  if (closed.length > 0) {
    notes.push(
      `Closed for these dates and unusable: ${closed.map((l) => l.name).join(", ")}. ` +
        "If the customer asked for one of these, say so and offer an alternative.",
    );
  }

  const shortNotice = locations.filter((l) => l.permit && !l.permit.haveEnoughNotice);
  if (shortNotice.length > 0) {
    notes.push(
      `Permit notice is too short for: ${shortNotice.map((l) => l.name).join(", ")}. ` +
        "Avoid these unless the customer can move their dates.",
    );
  }

  // Only vehicles that actually seat the group. A four-seat jeep for six
  // travellers is a booking that fails on the morning of departure.
  const transport = kb.transport().filter((t) => t.maxPax >= brief.groupSize);
  if (transport.length === 0) {
    notes.push(
      `No single vehicle seats ${brief.groupSize} travellers; the group needs more than one. ` +
        "Pricing will account for this.",
    );
  }

  const routes: RouteOffer[] = kb.routes().map((r) => ({
    id: r.id,
    driveHours: r.driveHours,
    maxAltitudeM: r.maxAltitudeM,
    roadQuality: r.roadQuality,
    requiresJeep: r.roadQuality !== "paved",
  }));

  return {
    locations,
    routes,
    transport,
    staffDayRates: kb.staff().map((s) => ({
      id: s.id,
      name: s.name,
      ratePerDayUsd: s.ratePerDayUsd,
      perGroup: s.perGroup,
    })),
    policy: {
      maxDriveHoursPerDay: kb.policy.maxDriveHoursPerDay,
      maxSleepGainPerDayM: kb.policy.maxSleepGainPerDayM,
      altitudeRuleAboveM: kb.policy.altitudeRuleAboveM,
    },
    notes,
  };
}

/**
 * Renders the retrieved slice as the text handed to compose.
 *
 * Deliberately terse and tabular. A long prose description of the catalogue
 * costs tokens on every call and gives the model room to read past a closure;
 * a table with an explicit CLOSED marker on each row does not.
 */
export function renderForPrompt(r: Retrieved, brief: Brief): string {
  const out: string[] = [];

  out.push("## Locations you may use");
  out.push("");
  out.push("id | elevation | status | season | hotels (id, tier, USD/room/night)");
  out.push("---|---|---|---|---");
  for (const l of r.locations) {
    const status =
      l.availability === "open"
        ? l.isDaytripOnly
          ? "OPEN (day trip only, no overnight)"
          : "open"
        : l.availability === "closed"
          ? "CLOSED"
          : "PARTIALLY CLOSED";
    const hotels =
      l.hotels.length === 0
        ? "none in budget"
        : l.hotels.map((h) => `${h.id} (${h.tier}, $${h.ratePerRoomUsd})`).join("; ");
    const permit = l.permit
      ? ` | PERMIT: ${l.permit.name}, ${l.permit.leadTimeDays}d notice${l.permit.haveEnoughNotice ? "" : " - NOT ENOUGH NOTICE"}`
      : "";
    out.push(`${l.id} | ${l.elevationM}m | ${status} | ${l.season} | ${hotels}${permit}`);
  }

  out.push("", "## Road segments you may use", "");
  out.push("Any segment may be travelled in either direction.");
  out.push("");
  out.push("id | hours | max altitude | surface");
  out.push("---|---|---|---");
  for (const s of r.routes) {
    out.push(`${s.id} | ${s.driveHours} | ${s.maxAltitudeM}m | ${s.roadQuality}`);
  }

  out.push("", "## Vehicles", "");
  if (r.transport.length === 0) {
    out.push(`No single vehicle seats ${brief.groupSize}. More than one will be needed.`);
  } else {
    for (const t of r.transport) out.push(`- ${t.id}: seats ${t.maxPax}, $${t.ratePerDayUsd}/day`);
  }

  out.push("", "## Hard limits", "");
  out.push(`- Maximum ${r.policy.maxDriveHoursPerDay} hours driving in any one day.`);
  out.push(
    `- Above ${r.policy.altitudeRuleAboveM}m, sleeping elevation may rise at most ` +
      `${r.policy.maxSleepGainPerDayM}m from the previous night.`,
  );

  if (r.notes.length > 0) {
    out.push("", "## Notes on this request", "");
    for (const n of r.notes) out.push(`- ${n}`);
  }

  return out.join("\n");
}
