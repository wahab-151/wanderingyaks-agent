import { describe, it, expect, beforeAll } from "vitest";
import { loadKb, type KB } from "./kb.js";
import { retrieve } from "./retrieve.js";
import { verify } from "./verify.js";
import { price } from "./price.js";
import { route } from "./router.js";
import type { Brief, DraftItinerary } from "./schemas.js";

/**
 * Evidence for the portability claim.
 *
 * The README says a second tour operator is a new directory rather than a
 * rewrite. That is an assertion, and ground rule 09 requires assertions to have
 * evidence behind them. These tests are the evidence.
 *
 * `highpass-demo` is a fictional operator working the same valleys as the first
 * tenant. It shares the entire region layer - identical roads, seasons and
 * permit rules, because those are facts about Pakistan rather than about either
 * company - and brings its own inventory, rates and operating policy.
 *
 * If any of these fail, the layering has leaked and tenant data has ended up
 * somewhere it can only serve one operator.
 */

let a: KB; // wanderingyaks
let b: KB; // highpass-demo

beforeAll(() => {
  a = loadKb("wanderingyaks");
  b = loadKb("highpass-demo");
});

function brief(over: Partial<Brief> = {}): Brief {
  return {
    groupSize: 4,
    nights: 7,
    startDate: "2026-07-10",
    endDate: "2026-07-17",
    budgetPpUsd: 900,
    nationalities: ["GB"],
    interests: ["mountains"],
    fitness: "moderate",
    hasChildren: false,
    notes: "",
    missingFields: [],
    ...over,
  };
}

describe("the region layer is shared", () => {
  it("gives both tenants the same geography", () => {
    expect(b.locations().map((l) => l.id).sort()).toEqual(a.locations().map((l) => l.id).sort());
  });

  it("gives both tenants the same road network", () => {
    expect(b.routes().map((r) => r.id).sort()).toEqual(a.routes().map((r) => r.id).sort());
  });

  it("closes Deosai in April for both, because that is a fact about the road", () => {
    expect(a.isOpen("deosai", "2026-04-20")).toBe(false);
    expect(b.isOpen("deosai", "2026-04-20")).toBe(false);
    expect(a.isOpen("deosai", "2026-07-20")).toBe(true);
    expect(b.isOpen("deosai", "2026-07-20")).toBe(true);
  });

  it("applies the same permit rules to both", () => {
    const forA = a.permitFor("shimshal", ["GB"]);
    const forB = b.permitFor("shimshal", ["GB"]);
    expect(forA?.zone.leadTimeDays).toBe(forB?.zone.leadTimeDays);
  });
});

describe("the tenant layer is not shared", () => {
  it("gives each operator a different inventory", () => {
    const idsA = new Set(a.hotels().map((h) => h.id));
    const idsB = new Set(b.hotels().map((h) => h.id));
    const overlap = [...idsA].filter((id) => idsB.has(id));
    expect(overlap).toEqual([]);
  });

  it("does not let one operator book the other's properties", () => {
    expect(a.hotel("skardu_midrange")).not.toBeNull();
    expect(b.hotel("skardu_midrange")).toBeNull();
    expect(b.hotel("hp_skardu_base")).not.toBeNull();
    expect(a.hotel("hp_skardu_base")).toBeNull();
  });

  it("gives each operator its own policy", () => {
    expect(a.policy.maxDriveHoursPerDay).toBe(6);
    expect(b.policy.maxDriveHoursPerDay).toBe(9);
    expect(a.policy.marginPct).not.toBe(b.policy.marginPct);
  });

  it("gives each operator its own catalogue", () => {
    const titlesA = a.packages().map((p) => p.id);
    const titlesB = b.packages().map((p) => p.id);
    expect(titlesA.some((t) => titlesB.includes(t))).toBe(false);
  });
});

describe("the same enquiry produces different work for each operator", () => {
  /**
   * Chilas to Skardu is 7 hours: over the touring operator's 6-hour limit and
   * under the trekking operator's 9-hour one. The same road, the same hours,
   * judged differently - which is exactly what a tenant-scoped policy is for.
   */
  const sevenHourDay = (hotels: [string, string]): DraftItinerary => ({
    title: "North to Skardu",
    days: [
      { day: 1, location: "chilas", activity: "arrive", hotelId: hotels[0], driveSegments: [], isRestDay: false },
      { day: 2, location: "skardu", activity: "drive up the Indus", hotelId: hotels[1], driveSegments: ["chilas>skardu"], isRestDay: false },
      { day: 3, location: "skardu", activity: "depart", hotelId: null, driveSegments: [], isRestDay: false },
    ],
    assumptions: [],
  });

  it("flags a 7-hour drive for the touring operator, whose limit is 6", () => {
    const found = verify({
      brief: brief({ nights: 2 }),
      draft: sevenHourDay(["chilas_transit", "skardu_midrange"]),
      kb: a,
      today: "2026-04-01",
    });
    expect(found.map((v) => v.code)).toContain("DRIVE_HOURS");
  });

  it("accepts the same drive for the trekking operator, whose limit is 9", () => {
    const found = verify({
      brief: brief({ nights: 2 }),
      draft: sevenHourDay(["hp_chilas_transit", "hp_skardu_base"]),
      kb: b,
      today: "2026-04-01",
    });
    expect(found.map((v) => v.code)).not.toContain("DRIVE_HOURS");
  });

  it("offers each operator a different set of candidate hotels", () => {
    const forA = retrieve(brief(), a, "2026-04-01").locations.find((l) => l.id === "skardu");
    const forB = retrieve(brief(), b, "2026-04-01").locations.find((l) => l.id === "skardu");
    expect(forA?.hotels.length).toBeGreaterThan(0);
    expect(forB?.hotels.length).toBeGreaterThan(0);
    expect(forA?.hotels[0]?.id).not.toBe(forB?.hotels[0]?.id);
  });

  it("quotes a different price for the same shape of trip", () => {
    const forA = price({
      brief: brief(),
      kb: a,
      draft: {
        title: "t",
        days: [
          { day: 1, location: "skardu", activity: "", hotelId: "skardu_midrange", driveSegments: [], isRestDay: false },
          { day: 2, location: "skardu", activity: "", hotelId: null, driveSegments: [], isRestDay: false },
        ],
        assumptions: [],
      },
    });
    const forB = price({
      brief: brief(),
      kb: b,
      draft: {
        title: "t",
        days: [
          { day: 1, location: "skardu", activity: "", hotelId: "hp_skardu_base", driveSegments: [], isRestDay: false },
          { day: 2, location: "skardu", activity: "", hotelId: null, driveSegments: [], isRestDay: false },
        ],
        assumptions: [],
      },
    });

    // Cheaper beds, cheaper staff, thinner margin.
    expect(forB.perPersonUsd).toBeLessThan(forA.perPersonUsd);
    expect(forB.marginPct).toBe(0.12);
    expect(forA.marginPct).toBe(0.18);
  });

  it("routes against whichever catalogue the loaded tenant brings", () => {
    const summerDeosai = brief({ nights: 5, startDate: "2026-07-10", interests: ["deosai"], budgetPpUsd: 700 });
    const forB = route(summerDeosai, b);
    // High Pass publishes a Deosai crossing; the other operator does not.
    expect(forB.candidates[0]?.pkg.id).toMatch(/^hp_/);
    expect(route(summerDeosai, a).candidates.every((c) => !c.pkg.id.startsWith("hp_"))).toBe(true);
  });
});

describe("nothing tenant-specific leaked into the code", () => {
  it("loads a tenant it has never seen without a code change", () => {
    // The whole claim, in one assertion: highpass-demo was added as a directory
    // and every module reads it through the same typed interface.
    expect(b.tenantName).toContain("High Pass");
    expect(b.hotels().length).toBeGreaterThan(10);
    expect(b.packages().length).toBeGreaterThan(0);
  });

  it("reports the second tenant as unverified too", () => {
    expect(b.hasUnverifiedData).toBe(true);
  });
});
