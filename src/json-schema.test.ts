import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toStrictJsonSchema, findUnsupportedKeywords, findNonStrictObjects } from "./json-schema.js";
import { Brief, DraftItinerary } from "./schemas.js";

/**
 * OpenAI strict structured outputs reject most JSON Schema validation keywords
 * with a 400 rather than ignoring them. Zod emits several of those keywords
 * from ordinary refinements - `.regex()`, `.min(1)`, `.positive()` - so an
 * unprocessed schema fails at request time, which is the worst place to find
 * out. These tests catch it at build time instead.
 */

describe("strict schema conversion", () => {
  it("strips every keyword strict mode rejects from the Brief", () => {
    const { schema } = toStrictJsonSchema(Brief, "brief");
    expect(findUnsupportedKeywords(schema)).toEqual([]);
  });

  it("strips every keyword strict mode rejects from the DraftItinerary", () => {
    const { schema } = toStrictJsonSchema(DraftItinerary, "draft_itinerary");
    expect(findUnsupportedKeywords(schema)).toEqual([]);
  });

  it("closes every object and marks every property required", () => {
    for (const [name, s] of [["brief", Brief], ["draft", DraftItinerary]] as const) {
      const { schema } = toStrictJsonSchema(s, name);
      expect(findNonStrictObjects(schema), name).toEqual([]);
    }
  });

  it("keeps the properties themselves intact", () => {
    const { schema } = toStrictJsonSchema(DraftItinerary, "draft_itinerary") as unknown as {
      schema: { properties: Record<string, unknown>; required: string[] };
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["assumptions", "days", "title"]);
    expect(schema.required.sort()).toEqual(["assumptions", "days", "title"]);
  });

  it("preserves nullability, which is how optional fields are expressed", () => {
    // Brief.startDate is nullable, and that has to survive - the model needs a
    // way to say "no date given" without inventing one.
    const json = JSON.stringify(toStrictJsonSchema(Brief, "brief").schema);
    expect(json).toContain("null");
  });

  it("removes a pattern but leaves the field", () => {
    const schema = z.object({ when: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
    const { schema: out } = toStrictJsonSchema(schema, "t") as unknown as {
      schema: { properties: { when: { type: string; pattern?: string } } };
    };
    expect(out.properties.when.type).toBe("string");
    expect(out.properties.when.pattern).toBeUndefined();
  });

  it("recurses into nested objects and arrays", () => {
    const schema = z.object({
      rows: z.array(z.object({ n: z.number().int().positive(), label: z.string().min(3) })).min(1),
    });
    const { schema: out } = toStrictJsonSchema(schema, "t");
    expect(findUnsupportedKeywords(out)).toEqual([]);
    expect(findNonStrictObjects(out)).toEqual([]);
  });

  it("names the schema for the request", () => {
    expect(toStrictJsonSchema(Brief, "brief").name).toBe("brief");
  });
});

describe("the constraints are still enforced, just not by the API", () => {
  /**
   * The point of stripping is that Zod remains the gate. A response that is
   * well-shaped but semantically wrong must still be rejected by llm.ts, which
   * re-validates against the original schema.
   */
  it("rejects a badly formatted date that the stripped schema would allow", () => {
    const stripped = toStrictJsonSchema(Brief, "brief");
    expect(findUnsupportedKeywords(stripped.schema)).toEqual([]);

    const wellShapedButWrong = {
      groupSize: 4,
      nights: 7,
      startDate: "next April",
      endDate: null,
      budgetPpUsd: 900,
      nationalities: ["GB"],
      interests: [],
      fitness: "moderate",
      hasChildren: false,
      notes: "",
      missingFields: [],
    };

    const result = Brief.safeParse(wellShapedButWrong);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/YYYY-MM-DD/);
  });

  it("rejects an itinerary with no days", () => {
    const result = DraftItinerary.safeParse({ title: "Empty", days: [], assumptions: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a group size of zero", () => {
    const result = Brief.safeParse({
      groupSize: 0,
      nights: 7,
      startDate: "2026-06-20",
      endDate: "2026-06-27",
      budgetPpUsd: 900,
      nationalities: ["GB"],
      interests: [],
      fitness: "low",
      hasChildren: false,
      notes: "",
      missingFields: [],
    });
    expect(result.success).toBe(false);
  });
});
