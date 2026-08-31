import type { KB } from "./kb.js";
import type { Brief, CostLine, CostSheet, DraftItinerary } from "./schemas.js";

/**
 * Turns an itinerary into a cost sheet. Pure arithmetic over knowledge base
 * rates; no model call, ever.
 *
 * A wrong quote is worse than no quote. It is the one output of this system
 * that binds the operator commercially, and a model that is right 95% of the
 * time is not good enough when the 5% is money. So every figure here traces to
 * a rate in inventory.yaml and an explicit rule below.
 *
 * Nothing computed here is stored. Prices are recomputed on every run so that
 * a rate change in the knowledge base cannot leave a stale quote behind.
 */

export class PriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceError";
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Vehicles are chosen by seats and by the roughest road on the itinerary.
 * A sedan booked for a jeep track is a trip that stops at the first river
 * crossing, so surface capability is a hard requirement, not a preference.
 */
function chooseTransport(draft: DraftItinerary, brief: Brief, kb: KB) {
  const needsJeep = draft.days.some((d) =>
    d.driveSegments.some((s) => {
      const route = kb.route(s);
      return route !== null && route.roadQuality !== "paved";
    }),
  );

  const suitable = kb
    .transport()
    .filter((t) => (needsJeep ? t.requiredFor.includes("jeep_track") || t.id === "jeep" : true))
    .sort((a, b) => a.ratePerDayUsd - b.ratePerDayUsd);

  if (suitable.length === 0) {
    throw new PriceError(
      `no vehicle in inventory can cover this itinerary${needsJeep ? " (jeep track required)" : ""}`,
    );
  }

  // Cheapest option that carries everyone, using multiple vehicles when no
  // single one is big enough.
  let best: { id: string; name: string; count: number; ratePerDayUsd: number } | null = null;
  for (const t of suitable) {
    const count = Math.ceil(brief.groupSize / t.maxPax);
    const dailyCost = count * t.ratePerDayUsd;
    if (best === null || dailyCost < best.count * best.ratePerDayUsd) {
      best = { id: t.id, name: t.name, count, ratePerDayUsd: t.ratePerDayUsd };
    }
  }
  return best!;
}

export function price(args: { draft: DraftItinerary; brief: Brief; kb: KB }): CostSheet {
  const { draft, brief, kb } = args;
  const lines: CostLine[] = [];

  const days = [...draft.days].sort((a, b) => a.day - b.day);
  const tripDays = days.length;

  // --- accommodation ------------------------------------------------------
  // Rates are per room, so the group is split into rooms first. An odd number
  // of travellers takes a whole extra room; half a room does not exist.
  for (const day of days) {
    if (day.hotelId === null) continue;

    const hotel = kb.hotel(day.hotelId);
    if (!hotel) {
      // verify() reports this as NO_INVENTORY. Pricing refuses outright rather
      // than substituting a rate, because a guessed rate is a wrong quote.
      throw new PriceError(
        `cannot price day ${day.day}: hotel "${day.hotelId}" is not in the inventory`,
      );
    }

    const rooms = Math.ceil(brief.groupSize / hotel.maxOccupancy);
    lines.push({
      label: `${hotel.name}, night of day ${day.day}`,
      category: "accommodation",
      unitUsd: hotel.ratePerRoomUsd,
      qty: rooms,
      amountUsd: round2(hotel.ratePerRoomUsd * rooms),
    });
  }

  // --- transport ----------------------------------------------------------
  // Charged for every day of the trip, not only driving days: the vehicle and
  // driver are retained for the duration and the operator pays for idle days.
  const vehicle = chooseTransport(draft, brief, kb);
  lines.push({
    label: `${vehicle.name}${vehicle.count > 1 ? ` x${vehicle.count}` : ""}, ${tripDays} days`,
    category: "transport",
    unitUsd: vehicle.ratePerDayUsd,
    qty: vehicle.count * tripDays,
    amountUsd: round2(vehicle.ratePerDayUsd * vehicle.count * tripDays),
  });

  // --- staff --------------------------------------------------------------
  const guide = kb.staff().find((s) => s.id === "guide");
  if (guide) {
    const qty = guide.perGroup ? tripDays : tripDays * brief.groupSize;
    lines.push({
      label: `${guide.name}, ${tripDays} days`,
      category: "staff",
      unitUsd: guide.ratePerDayUsd,
      qty,
      amountUsd: round2(guide.ratePerDayUsd * qty),
    });
  }

  // --- extras -------------------------------------------------------------
  // Park fees are charged once per person per restricted zone entered, not per
  // day spent in it.
  const zonesVisited = new Set(
    days.map((d) => d.location).filter((id) => kb.restrictedZone(id) !== null),
  );
  for (const zoneId of zonesVisited) {
    const extra = kb.extra(`permit_${zoneId}`);
    if (!extra) continue;
    const qty = extra.per === "person" ? brief.groupSize : 1;
    lines.push({
      label: extra.name,
      category: "extras",
      unitUsd: extra.unitUsd,
      qty,
      amountUsd: round2(extra.unitUsd * qty),
    });
  }

  // --- totals -------------------------------------------------------------
  const subtotalUsd = round2(lines.reduce((sum, l) => sum + l.amountUsd, 0));
  const marginPct = kb.policy.marginPct;
  const totalUsd = round2(subtotalUsd * (1 + marginPct));
  const perPersonUsd = round2(totalUsd / brief.groupSize);

  return { lines, subtotalUsd, marginPct, totalUsd, perPersonUsd };
}

/** Internal cost sheet, for the operator rather than the customer. */
export function renderCostSheet(sheet: CostSheet, brief: Brief, currency = "USD"): string {
  const out: string[] = [];
  const money = (n: number) => `${currency} ${n.toFixed(2)}`;

  out.push("Internal cost sheet");
  out.push("===================");
  out.push("");

  for (const category of ["accommodation", "transport", "staff", "extras"] as const) {
    const inCategory = sheet.lines.filter((l) => l.category === category);
    if (inCategory.length === 0) continue;
    out.push(category.toUpperCase());
    for (const l of inCategory) {
      out.push(`  ${l.label.padEnd(46)} ${String(l.qty).padStart(4)} x ${money(l.unitUsd).padStart(12)} = ${money(l.amountUsd).padStart(12)}`);
    }
    const sum = inCategory.reduce((a, l) => a + l.amountUsd, 0);
    out.push(`  ${"subtotal".padEnd(46)} ${" ".repeat(21)} ${money(round2(sum)).padStart(12)}`);
    out.push("");
  }

  out.push(`${"Cost subtotal".padEnd(52)} ${money(sheet.subtotalUsd).padStart(20)}`);
  out.push(`${`Margin (${(sheet.marginPct * 100).toFixed(0)}%)`.padEnd(52)} ${money(round2(sheet.totalUsd - sheet.subtotalUsd)).padStart(20)}`);
  out.push(`${"TOTAL".padEnd(52)} ${money(sheet.totalUsd).padStart(20)}`);
  out.push(`${`Per person (${brief.groupSize} travelling)`.padEnd(52)} ${money(sheet.perPersonUsd).padStart(20)}`);

  if (brief.budgetPpUsd !== null) {
    const delta = sheet.perPersonUsd - brief.budgetPpUsd;
    out.push("");
    out.push(
      `Against stated budget of ${money(brief.budgetPpUsd)} per person: ` +
        `${delta > 0 ? "OVER" : "under"} by ${money(Math.abs(round2(delta)))}`,
    );
  }

  return out.join("\n");
}
