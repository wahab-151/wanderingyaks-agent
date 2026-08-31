import { z, type ZodType } from "zod";

/**
 * Converts a Zod schema into the restricted JSON Schema dialect OpenAI's strict
 * structured outputs accept.
 *
 * Two things have to happen. First, strict mode rejects most validation
 * keywords - `pattern`, `minItems`, `minimum`, `exclusiveMinimum`, `format` and
 * friends all produce a 400 rather than being ignored - so they are stripped.
 * Second, strict mode requires every object to carry `additionalProperties:
 * false` and to list every property in `required`, which Zod does not do for
 * fields it considers optional.
 *
 * Stripping the constraints does not lose them. The API guarantees the *shape*
 * of the response; llm.ts then re-validates the parsed value against the full
 * Zod schema, which is where `pattern` on a date, `positive` on a group size
 * and `min(1)` on the day list are actually enforced. A model that returns a
 * well-shaped but semantically invalid answer is caught there and retried with
 * the specific failure fed back.
 *
 * The division is deliberate: the API constrains structure, Zod constrains
 * meaning, and neither is trusted to do the other's job.
 */

/** Keywords strict mode rejects outright. */
const STRIPPED = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "default",
  "$schema",
  "contentEncoding",
  "contentMediaType",
]);

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relax(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(relax);
  if (!isPlainObject(node)) return node;

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED.has(key)) continue;
    out[key] = relax(value);
  }

  // Strict mode demands a closed object listing every property as required.
  // Optionality still round-trips: schemas in this project express "may be
  // absent" as `.nullable()`, which survives as a union with null.
  if (out["type"] === "object" && isPlainObject(out["properties"])) {
    out["additionalProperties"] = false;
    out["required"] = Object.keys(out["properties"]);
  }

  return out;
}

export interface StrictSchema {
  name: string;
  schema: JsonObject;
}

export function toStrictJsonSchema(schema: ZodType, name: string): StrictSchema {
  const raw = z.toJSONSchema(schema, { io: "output" }) as JsonObject;
  return { name, schema: relax(raw) as JsonObject };
}

/** Exported for tests: asserts nothing strict mode would reject survived. */
export function findUnsupportedKeywords(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => findUnsupportedKeywords(n, `${path}[${i}]`));
  if (!isPlainObject(node)) return [];

  const found: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED.has(key)) found.push(`${path}.${key}`);
    found.push(...findUnsupportedKeywords(value, `${path}.${key}`));
  }
  return found;
}

/** Exported for tests: every object must be closed and fully required. */
export function findNonStrictObjects(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => findNonStrictObjects(n, `${path}[${i}]`));
  if (!isPlainObject(node)) return [];

  const problems: string[] = [];
  if (node["type"] === "object" && isPlainObject(node["properties"])) {
    const props = Object.keys(node["properties"]);
    const required = Array.isArray(node["required"]) ? (node["required"] as string[]) : [];
    if (node["additionalProperties"] !== false) problems.push(`${path}: additionalProperties not false`);
    const missing = props.filter((p) => !required.includes(p));
    if (missing.length > 0) problems.push(`${path}: not required -> ${missing.join(", ")}`);
  }
  for (const [key, value] of Object.entries(node)) {
    problems.push(...findNonStrictObjects(value, `${path}.${key}`));
  }
  return problems;
}
