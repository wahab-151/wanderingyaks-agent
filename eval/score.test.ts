import { describe, it, expect, beforeAll } from "vitest";
import { loadKb, type KB } from "../src/kb.js";
import { familyOf, scoreCase, scoreability, summarise, renderMarkdown, FAMILIES } from "./score.js";
import { loadCases } from "./load-cases.js";
import type { DraftItinerary, Violation, ViolationCode } from "../src/schemas.js";

let kb: KB;
beforeAll(() => {
  kb = loadKb("wanderingyaks");
});

const v = (code: ViolationCode, severity: "hard" | "soft" = "hard", day = 1): Violation => ({
  code,
  day,
  detail: "",
  severity,
});

const draft = (locations: string[]): DraftItinerary => ({
  title: "t",
  days: locations.map((location, i) => ({
    day: i + 1,
    location,
    activity: "",
    hotelId: null,
    driveSegments: [],
    isRestDay: false,
  })),
  assumptions: [],
});

describe("violation families", () => {
  it("assigns every violation code to exactly one family", () => {
    const all = Object.values(FAMILIES).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("puts the codes the agent wins by construction in grounding", () => {
    expect(familyOf("NO_INVENTORY")).toBe("grounding");
    expect(familyOf("UNKNOWN_LOCATION")).toBe("grounding");
    expect(familyOf("UNKNOWN_SEGMENT")).toBe("grounding");
  });

  it("puts the codes the agent has to earn in feasibility", () => {
    expect(familyOf("CLOSED")).toBe("feasibility");
    expect(familyOf("ALTITUDE_GAIN")).toBe("feasibility");
    expect(familyOf("DRIVE_HOURS")).toBe("feasibility");
    expect(familyOf("PERMIT_MISSING")).toBe("feasibility");
  });
});

describe("scoreability", () => {
  it("counts days whose location the knowledge base recognises", () => {
    const s = scoreability(draft(["skardu", "invented_valley", "khaplu", "nowhere_gah"]), kb);
    expect(s.totalDays).toBe(4);
    expect(s.feasibilityCheckedDays).toBe(2);
    expect(s.unknownLocations.sort()).toEqual(["invented_valley", "nowhere_gah"]);
  });

  it("reports full coverage when every location resolves", () => {
    const s = scoreability(draft(["skardu", "khaplu"]), kb);
    expect(s.feasibilityCheckedDays).toBe(2);
    expect(s.unknownLocations).toEqual([]);
  });
});

describe("case scoring", () => {
  // A function, not a constant: the describe body runs before beforeAll, so a
  // constant would capture kb while it is still undefined.
  const base = () => ({
    caseId: "case-01",
    system: "baseline",
    draft: draft(["skardu", "khaplu"]),
    kb,
    costUsd: 0.15,
    latencyMs: 90_000,
    llmCalls: 2,
  });

  it("separates the families rather than reporting one number", () => {
    const score = scoreCase({
      ...base(),
      violations: [v("NO_INVENTORY"), v("UNKNOWN_LOCATION"), v("CLOSED"), v("NIGHTS_MISMATCH")],
    });
    expect(score.hardByFamily.grounding).toBe(2);
    expect(score.hardByFamily.feasibility).toBe(1);
    expect(score.hardByFamily.fidelity).toBe(1);
    expect(score.hard).toBe(4);
  });

  it("does not count soft violations as blocking", () => {
    const score = scoreCase({ ...base(), violations: [v("BUDGET_EXCEEDED", "soft")] });
    expect(score.hard).toBe(0);
    expect(score.soft).toBe(1);
    expect(score.sendable).toBe(true);
  });

  it("marks a clean itinerary sendable", () => {
    expect(scoreCase({ ...base(), violations: [] }).sendable).toBe(true);
  });
});

describe("summary", () => {
  const mk = (feas: number, ground: number) =>
    scoreCase({
      caseId: "c",
      system: "baseline",
      draft: draft(["skardu"]),
      kb,
      costUsd: 0.1,
      latencyMs: 1000,
      llmCalls: 1,
      violations: [
        ...Array.from({ length: feas }, () => v("CLOSED")),
        ...Array.from({ length: ground }, () => v("NO_INVENTORY")),
      ],
    });

  it("averages each family independently", () => {
    const s = summarise("baseline", [mk(2, 4), mk(0, 6)]);
    expect(s.meanFeasibilityHard).toBe(1);
    expect(s.meanGroundingHard).toBe(5);
    expect(s.meanHard).toBe(6);
  });

  it("excludes errored runs from the averages but still counts them", () => {
    const errored = { ...mk(0, 0), error: "timed out" };
    const s = summarise("baseline", [mk(4, 0), errored]);
    expect(s.failedRuns).toBe(1);
    expect(s.cases).toBe(2);
    expect(s.meanFeasibilityHard).toBe(4); // not halved by the failure
  });

  it("reports what fraction of days could be checked at all", () => {
    const partial = scoreCase({
      caseId: "c",
      system: "baseline",
      draft: draft(["skardu", "invented_valley", "nowhere_gah", "khaplu"]),
      kb,
      costUsd: 0,
      latencyMs: 0,
      llmCalls: 0,
      violations: [],
    });
    expect(summarise("baseline", [partial]).meanScoreableFraction).toBe(0.5);
  });
});

describe("report", () => {
  it("leads with feasibility, not the combined total", () => {
    const score = scoreCase({
      caseId: "case-01",
      system: "baseline",
      draft: draft(["skardu"]),
      kb,
      costUsd: 0.1,
      latencyMs: 1000,
      llmCalls: 1,
      violations: [v("CLOSED")],
    });
    const md = renderMarkdown([summarise("baseline", [score])], [score]);
    const feasIndex = md.indexOf("Feasibility violations / itinerary");
    const allIndex = md.indexOf("All hard violations / itinerary");
    expect(feasIndex).toBeGreaterThan(-1);
    expect(feasIndex).toBeLessThan(allIndex);
  });

  it("includes the checkable-days column so a thin result is visible", () => {
    const score = scoreCase({
      caseId: "case-01",
      system: "baseline",
      draft: draft(["invented_valley", "skardu"]),
      kb,
      costUsd: 0,
      latencyMs: 0,
      llmCalls: 0,
      violations: [],
    });
    expect(renderMarkdown([summarise("baseline", [score])], [score])).toContain("1/2");
  });
});

describe("eval cases", () => {
  it("all load and validate", () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  it("are all marked synthetic while no real data has been scrubbed", () => {
    // Flip these to "anonymised-real" only after a human has read each one.
    for (const c of loadCases()) {
      expect(c.provenance, c.id).toBe("synthetic");
    }
  });

  it("includes at least one deliberately hard case", () => {
    expect(loadCases().some((c) => c.difficulty === "hard")).toBe(true);
  });

  it("pins today on every case so permit checks do not drift", () => {
    for (const c of loadCases()) {
      expect(c.today, c.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("rejects a case id that does not exist", () => {
    expect(() => loadCases(["case-99"])).toThrow(/no such eval case/);
  });
});
