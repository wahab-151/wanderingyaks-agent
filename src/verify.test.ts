import { describe, it, expect, beforeAll } from "vitest";
import { loadKb, type KB } from "./kb.js";
import { verify, isFeasible, hardViolations, DEFAULT_HELD_OUT } from "./verify.js";
import type { Brief, Day, DraftItinerary, ViolationCode } from "./schemas.js";

let kb: KB;
beforeAll(() => {
  kb = loadKb("wanderingyaks");
});

/** Fixed so permit lead-time checks do not drift as the calendar moves. */
const TODAY = "2026-05-01";

function brief(overrides: Partial<Brief> = {}): Brief {
  return {
    groupSize: 4,
    nights: 7,
    startDate: "2026-06-20",
    endDate: "2026-06-27",
    budgetPpUsd: 1200,
    nationalities: ["GB"],
    interests: ["culture", "mountains"],
    fitness: "moderate",
    hasChildren: false,
    notes: "",
    missingFields: [],
    ...overrides,
  };
}

function day(
  n: number,
  location: string,
  hotelId: string | null,
  driveSegments: string[] = [],
): Day {
  return { day: n, location, activity: "sightseeing", hotelId, driveSegments, isRestDay: false };
}

/**
 * A deliberately ordinary Baltistan trip that should pass every rule. If this
 * ever starts failing, a rule has become too strict - which matters more than
 * a missed violation, because false positives send the repair loop chasing
 * problems that are not there.
 */
function cleanDraft(): DraftItinerary {
  return {
    title: "Skardu and Baltistan, 8 days",
    days: [
      day(1, "islamabad", "islamabad_standard"),
      day(2, "skardu", "skardu_midrange"),
      day(3, "skardu", "skardu_midrange"),
      day(4, "shigar", "skardu_serena", ["skardu>shigar"]),
      day(5, "khaplu", "khaplu_guesthouse", ["shigar>khaplu"]),
      day(6, "kachura", "shangrila_kachura", ["khaplu>skardu", "skardu>kachura"]),
      day(7, "skardu", "skardu_midrange", ["kachura>skardu"]),
      day(8, "islamabad", null),
    ],
    assumptions: ["Flights Islamabad-Skardu assumed available"],
  };
}

const codes = (vs: { code: ViolationCode }[]) => vs.map((v) => v.code);

function run(draft: DraftItinerary, b: Brief = brief()) {
  return verify({ brief: b, draft, kb, today: TODAY });
}

// ---------------------------------------------------------------------------

describe("knowledge base", () => {
  it("loads and passes referential integrity", () => {
    expect(kb.tenantId).toBe("wanderingyaks");
    expect(kb.locations().length).toBeGreaterThan(10);
    expect(kb.hotels().length).toBeGreaterThan(5);
  });

  it("reports that it is still carrying unverified placeholder data", () => {
    // This must stay true until the operator signs off the real rates and
    // thresholds. When it flips to false, delete this test.
    expect(kb.hasUnverifiedData).toBe(true);
    expect(kb.unverifiedFiles.some((f) => f.includes("inventory.yaml"))).toBe(true);
  });

  it("resolves a road in the direction it is not stored in", () => {
    expect(kb.route("skardu>khaplu")).not.toBeNull();
    expect(kb.route("khaplu>skardu")?.driveHours).toBe(3.0);
    expect(kb.route("skardu>narnia")).toBeNull();
  });

  it("rejects a tenant whose knowledge base does not exist", () => {
    expect(() => loadKb("no-such-operator")).toThrow(/missing knowledge base file/);
  });
});

describe("verify - a feasible itinerary", () => {
  it("returns no violations at all", () => {
    expect(run(cleanDraft())).toEqual([]);
  });

  it("is feasible", () => {
    expect(isFeasible(run(cleanDraft()))).toBe(true);
  });
});

describe("verify - grounding failures", () => {
  it("catches a hotel that is not in the operator inventory", () => {
    const draft = cleanDraft();
    draft.days[1] = day(2, "skardu", "skardu_grand_palace");
    expect(codes(run(draft))).toContain("NO_INVENTORY");
  });

  it("catches a real hotel placed in the wrong town", () => {
    const draft = cleanDraft();
    draft.days[1] = day(2, "skardu", "hunza_standard");
    const v = run(draft).find((x) => x.code === "NO_INVENTORY");
    expect(v?.detail).toMatch(/is in karimabad/);
  });

  it("catches an invented location", () => {
    const draft = cleanDraft();
    draft.days[2] = day(3, "shangri_la_valley", null);
    expect(codes(run(draft))).toContain("UNKNOWN_LOCATION");
  });

  it("catches an invented road", () => {
    const draft = cleanDraft();
    draft.days[3] = day(4, "shigar", "skardu_serena", ["skardu>hidden_valley"]);
    expect(codes(run(draft))).toContain("UNKNOWN_SEGMENT");
  });

  it("catches an unbooked night", () => {
    const draft = cleanDraft();
    draft.days[2] = day(3, "skardu", null);
    expect(codes(run(draft))).toContain("NO_INVENTORY");
  });

  it("does not treat the departure day as an unbooked night", () => {
    expect(codes(run(cleanDraft()))).not.toContain("NO_INVENTORY");
  });
});

describe("verify - physical constraints", () => {
  it("catches a drive day over the operator limit", () => {
    const draft = cleanDraft();
    // Islamabad to Chilas is 10h against a 6h policy.
    draft.days[1] = day(2, "chilas", "chilas_transit", ["islamabad>chilas"]);
    const v = run(draft).find((x) => x.code === "DRIVE_HOURS");
    expect(v?.detail).toMatch(/10\.0h/);
  });

  it("sums multiple segments on one day before comparing to the limit", () => {
    const draft = cleanDraft();
    // 3.0 + 6.0 = 9h, neither segment alone is over the limit.
    draft.days[5] = day(6, "gilgit", "gilgit_standard", ["khaplu>skardu", "skardu>gilgit"]);
    expect(codes(run(draft))).toContain("DRIVE_HOURS");
  });

  it("catches sleeping too high too fast", () => {
    const draft = cleanDraft();
    // Skardu 2230m straight to the Deosai camp at 4100m.
    draft.days[3] = day(4, "deosai", "deosai_camp", ["skardu>deosai"]);
    const v = run(draft).find((x) => x.code === "ALTITUDE_GAIN");
    expect(v?.detail).toMatch(/1870m/);
  });

  it("does not flag a descent", () => {
    const draft = cleanDraft();
    draft.days[4] = day(5, "skardu", "skardu_midrange", ["shigar>skardu"]);
    expect(codes(run(draft))).not.toContain("ALTITUDE_GAIN");
  });

  it("refuses a night stop where there is no accommodation", () => {
    const draft = cleanDraft();
    draft.days[3] = day(4, "khunjerab", "hunza_standard", []);
    expect(codes(run(draft))).toContain("NO_INVENTORY");
  });
});

describe("verify - the April Deosai case", () => {
  /**
   * The scenario the whole project exists for. A generic model produces a
   * fluent, confident, unrunnable itinerary: Deosai is under snow in April,
   * the gain from Skardu is nearly 1900m in a day, and a foreign group needs
   * three days notice for the park permit.
   */
  const aprilDeosai = (): DraftItinerary => {
    const draft = cleanDraft();
    draft.days[3] = day(4, "deosai", "deosai_camp", ["skardu>deosai"]);
    draft.days[4] = day(5, "skardu", "skardu_midrange", ["deosai>skardu"]);
    return draft;
  };
  const aprilBrief = brief({ startDate: "2026-04-18", endDate: "2026-04-25" });

  it("is rejected", () => {
    expect(isFeasible(run(aprilDeosai(), aprilBrief))).toBe(false);
  });

  it("names the closure, not just a generic failure", () => {
    const v = run(aprilDeosai(), aprilBrief).find((x) => x.code === "CLOSED");
    expect(v?.detail).toMatch(/Deosai/);
    expect(v?.detail).toMatch(/06-15/);
  });

  it("catches the same trip in June, when only altitude is the problem", () => {
    const found = codes(run(aprilDeosai(), brief({ startDate: "2026-07-01", endDate: "2026-07-08" })));
    expect(found).not.toContain("CLOSED");
    expect(found).toContain("ALTITUDE_GAIN");
  });
});

describe("verify - permits", () => {
  it("catches insufficient notice for a restricted zone", () => {
    const draft = cleanDraft();
    draft.days[3] = day(4, "shimshal", "shimshal_homestay", []);
    // Shimshal needs 7 days for foreign nationals; arrival is 2 days out.
    const b = brief({ startDate: "2026-05-01", endDate: "2026-05-08" });
    const v = run(draft, b).find((x) => x.code === "PERMIT_MISSING");
    expect(v?.detail).toMatch(/Shimshal/);
  });

  it("does not require a permit the group is exempt from", () => {
    const draft = cleanDraft();
    draft.days[3] = day(4, "shimshal", "shimshal_homestay", []);
    // Shimshal applies to foreign nationals only.
    const b = brief({ nationalities: ["PK"], startDate: "2026-05-02" });
    expect(codes(run(draft, b))).not.toContain("PERMIT_MISSING");
  });

  it("catches an NOC lead time attached to the traveller rather than the place", () => {
    const b = brief({ nationalities: ["IN"], startDate: "2026-05-10" });
    const v = run(cleanDraft(), b).find((x) => x.code === "PERMIT_MISSING");
    expect(v?.detail).toMatch(/NOC/);
  });

  it("warns rather than blocks when nationality is unknown", () => {
    const draft = cleanDraft();
    draft.days[3] = day(4, "shimshal", "shimshal_homestay", []);
    const v = run(draft, brief({ nationalities: [] })).find((x) => x.code === "PERMIT_MISSING");
    expect(v?.severity).toBe("soft");
  });
});

describe("verify - brief agreement", () => {
  it("catches a night count that does not match the brief", () => {
    expect(codes(run(cleanDraft(), brief({ nights: 10 })))).toContain("NIGHTS_MISMATCH");
  });

  it("flags an itinerary it could not date-check, without blocking it", () => {
    const v = run(cleanDraft(), brief({ startDate: null, endDate: null })).find(
      (x) => x.code === "UNVERIFIABLE_DATES",
    );
    expect(v?.severity).toBe("soft");
  });

  it("treats going over budget as a warning for the operator, not a block", () => {
    const costSheet = {
      lines: [],
      subtotalUsd: 8000,
      marginPct: 0.18,
      totalUsd: 9440,
      perPersonUsd: 2360,
    };
    const found = verify({ brief: brief(), draft: cleanDraft(), kb, costSheet, today: TODAY });
    expect(found.find((x) => x.code === "BUDGET_EXCEEDED")?.severity).toBe("soft");
    expect(isFeasible(found)).toBe(true);
  });
});

describe("verify - held-out rules", () => {
  /**
   * The repair loop must not see these codes, so that the evaluation can
   * report violations the agent avoided without ever being told about them.
   */
  const draft = () => {
    const d = cleanDraft();
    d.days[3] = day(4, "deosai", "deosai_camp", ["skardu>deosai"]);
    return d;
  };
  const b = brief({ startDate: "2026-07-01", endDate: "2026-07-08" });

  it("reports held-out violations on a full pass", () => {
    expect(codes(run(draft(), b))).toContain("ALTITUDE_GAIN");
  });

  it("hides them from a repair-loop pass", () => {
    const found = verify(
      { brief: b, draft: draft(), kb, today: TODAY },
      { exclude: DEFAULT_HELD_OUT },
    );
    expect(codes(found)).not.toContain("ALTITUDE_GAIN");
    expect(codes(found)).not.toContain("PERMIT_MISSING");
  });

  it("still reports non-held-out violations to the repair loop", () => {
    const d = draft();
    d.days[1] = day(2, "skardu", "invented_hotel");
    const found = verify(
      { brief: b, draft: d, kb, today: TODAY },
      { exclude: DEFAULT_HELD_OUT },
    );
    expect(codes(found)).toContain("NO_INVENTORY");
  });

  it("leaves the operator gate seeing everything", () => {
    // hardViolations() is what the review screen renders; it must not filter.
    expect(hardViolations(run(draft(), b)).length).toBeGreaterThan(0);
  });
});
