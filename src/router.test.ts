import { describe, it, expect, beforeAll } from "vitest";
import { loadKb, type KB } from "./kb.js";
import { route, scorePackage, RECOMMEND_THRESHOLD } from "./router.js";
import type { Brief, Package } from "./schemas.js";

let kb: KB;
beforeAll(() => {
  kb = loadKb("wanderingyaks");
});

function brief(over: Partial<Brief> = {}): Brief {
  return {
    groupSize: 2,
    nights: 9,
    startDate: "2026-07-10",
    endDate: "2026-07-19",
    budgetPpUsd: 1800,
    nationalities: ["DE"],
    interests: ["culture", "forts"],
    fitness: "low",
    hasChildren: false,
    notes: "",
    missingFields: [],
    ...over,
  };
}

const hunza: Package = {
  id: "hunza_cultural_10d",
  title: "Hunza Cultural Tour",
  nights: 9,
  locations: ["islamabad", "gilgit", "karimabad", "attabad", "gulmit", "passu", "nagar"],
  fitness: "low",
  fromUsd: 1690,
  bestMonths: [4, 5, 6, 7, 8, 9, 10],
};

describe("package scoring", () => {
  it("scores an exact fit highly", () => {
    const m = scorePackage(brief({ interests: ["culture", "karimabad", "forts"] }), hunza);
    expect(m.score).toBeGreaterThanOrEqual(RECOMMEND_THRESHOLD);
  });

  it("penalises a trip that is the wrong length", () => {
    const near = scorePackage(brief({ nights: 9 }), hunza).score;
    const far = scorePackage(brief({ nights: 4 }), hunza).score;
    expect(far).toBeLessThan(near);
  });

  it("rules out a package that does not run in the requested month", () => {
    // Hunza cultural runs April to October. January is not a near miss.
    const winter = scorePackage(brief({ startDate: "2026-01-10" }), hunza);
    expect(winter.score).toBeLessThan(RECOMMEND_THRESHOLD);
    expect(winter.gaps.join(" ")).toMatch(/month/);
  });

  it("lets a fitter group take an easier trip", () => {
    const asked = scorePackage(brief({ fitness: "high" }), hunza).score;
    const exact = scorePackage(brief({ fitness: "low" }), hunza).score;
    expect(asked).toBeLessThan(exact);
    expect(asked).toBeGreaterThan(0);
  });

  it("refuses to put a low-fitness group on a demanding trip", () => {
    const trek: Package = { ...hunza, id: "trek", fitness: "high" };
    const m = scorePackage(brief({ fitness: "low" }), trek);
    expect(m.gaps.join(" ")).toMatch(/fitness/);
    expect(m.score).toBeLessThan(RECOMMEND_THRESHOLD);
  });

  it("tolerates being slightly over budget but not far over", () => {
    const slightly = scorePackage(brief({ budgetPpUsd: 1600 }), hunza).score;
    const far = scorePackage(brief({ budgetPpUsd: 600 }), hunza).score;
    expect(slightly).toBeGreaterThan(far);
  });

  it("does not treat an unstated budget as a failure", () => {
    const m = scorePackage(brief({ budgetPpUsd: null }), hunza);
    expect(m.score).toBeGreaterThan(0.5);
  });
});

describe("routing decisions", () => {
  it("composes when nothing in the catalogue is close", () => {
    // Six students, five nights, $300, in May. No published trip is near this.
    const decision = route(
      brief({ groupSize: 6, nights: 5, budgetPpUsd: 300, startDate: "2026-05-08", fitness: "moderate", interests: ["mountains"] }),
      kb,
    );
    expect(decision.action).toBe("compose");
    expect(decision.match).toBeNull();
  });

  it("explains why it chose to compose, naming the closest miss", () => {
    const decision = route(brief({ nights: 5, budgetPpUsd: 300 }), kb);
    expect(decision.rationale).toMatch(/best catalogue match/);
    expect(decision.rationale).toMatch(/threshold/);
  });

  it("ranks candidates so an operator can see the runners-up", () => {
    const decision = route(brief(), kb);
    expect(decision.candidates.length).toBe(kb.packages().length);
    const scores = decision.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("never recommends below the threshold", () => {
    for (const nights of [1, 3, 5, 14, 30]) {
      const decision = route(brief({ nights }), kb);
      if (decision.action === "recommend") {
        expect(decision.match!.score).toBeGreaterThanOrEqual(RECOMMEND_THRESHOLD);
      }
    }
  });

  it("copes with an empty catalogue rather than throwing", () => {
    const emptyKb = { ...kb, packages: () => [] } as KB;
    const decision = route(brief(), emptyKb);
    expect(decision.action).toBe("compose");
    expect(decision.rationale).toMatch(/empty/);
  });
});
