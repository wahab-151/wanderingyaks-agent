import OpenAI from "openai";
import type { ZodType, infer as ZodInfer } from "zod";
import { toStrictJsonSchema } from "./json-schema.js";
import { Trajectory, estimateCostUsd, type TokenUsage } from "./trajectory.js";

/**
 * The only file in the project that talks to a model.
 *
 * Every stage that needs the model goes through structured(), so trajectory
 * logging, cost accounting, schema validation and retry policy are decided once
 * rather than repeated - and none of them can be forgotten in a new stage.
 *
 * That single seam is why swapping providers touched this file and the pricing
 * table, and nothing else. The verifier, the knowledge base, the pricing and
 * the eval harness never learn which model vendor is behind the pipeline.
 */

export const DEFAULT_MODEL = "gpt-5";
export const MAX_OUTPUT_TOKENS = 16_000;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  if (!process.env.OPENAI_API_KEY) {
    throw new LlmError(
      "No OpenAI credentials found. Set OPENAI_API_KEY in .env (copy .env.example). " +
        "The knowledge base and verifier run without a key; only the model stages need one.",
      "init",
      0,
    );
  }
  client = new OpenAI();
  return client;
}

export function currentModel(): string {
  return process.env.MODEL ?? DEFAULT_MODEL;
}

export interface StructuredOptions<T extends ZodType> {
  /** Pipeline stage name: "intake", "compose", "repair", "render". */
  stage: string;
  /** Contract the response must satisfy. Enforced by the API and re-checked here. */
  schema: T;
  /** Name for the schema in the API request. Lowercase with underscores. */
  schemaName?: string;
  /** Stable instructions. Identical across cases, so this is the cached prefix. */
  system: string;
  /** Case-specific input. Never put stable text here or the cache never hits. */
  user: string;
  trajectory: Trajectory;
  /** Attempts allowed if the model returns something the schema rejects. */
  maxAttempts?: number;
  /** Reasoning depth. Omitted means the model default. */
  effort?: "minimal" | "low" | "medium" | "high";
}

type OpenAIUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  input_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
  output_tokens_details?: { reasoning_tokens?: number | null } | null;
} | null | undefined;

function readUsage(usage: OpenAIUsage): TokenUsage {
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const written = usage?.input_tokens_details?.cache_write_tokens ?? 0;
  // input_tokens is the total including cached; the pricing table bills the
  // cached portion separately, so it must not be counted twice.
  const total = usage?.input_tokens ?? 0;
  return {
    inputTokens: Math.max(0, total - cached),
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * One model call returning a value that satisfies `schema`.
 *
 * Instructions are sent separately from the user turn and are byte-identical
 * across cases, which is what lets OpenAI's automatic prefix caching apply.
 * Whether it actually applies shows up as cacheReadTokens in the trajectory -
 * if that stays at zero across an eval run, something in the "stable" half is
 * not stable.
 */
export async function structured<T extends ZodType>(
  opts: StructuredOptions<T>,
): Promise<ZodInfer<T>> {
  const { stage, schema, system, user, trajectory } = opts;
  const maxAttempts = opts.maxAttempts ?? 2;
  const model = currentModel();
  const openai = getClient();
  const systemHash = trajectory.prompt(stage, system);
  const format = toStrictJsonSchema(schema, opts.schemaName ?? stage.replace(/-/g, "_"));

  let correction = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    const userContent = correction ? `${user}\n\n${correction}` : user;

    try {
      const response = await openai.responses.create({
        model,
        instructions: system,
        input: userContent,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        text: {
          format: {
            type: "json_schema",
            name: format.name,
            strict: true,
            schema: format.schema,
          },
        },
        ...(opts.effort ? { reasoning: { effort: opts.effort } } : {}),
      });

      const latencyMs = Date.now() - startedAt;
      const usage = readUsage(response.usage);
      const costUsd = estimateCostUsd(model, usage);

      // A truncated response is well-formed JSON right up to where it stops,
      // so this has to be checked before the payload is parsed.
      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason ?? "unknown";
        trajectory.llmError(stage, attempt, `incomplete response: ${reason}`, latencyMs);
        throw new LlmError(`${stage} response was cut off (${reason})`, stage, attempt);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.output_text);
      } catch {
        trajectory.llmError(stage, attempt, "response was not valid JSON", latencyMs);
        correction = "Your previous response was not valid JSON. Return only the JSON value.";
        continue;
      }

      // The API guarantees shape; this is where meaning is enforced. Date
      // patterns, positive integers and non-empty day lists are all stripped
      // from the schema the API sees, so they are only checked here.
      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        const detail = validated.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        trajectory.llmError(stage, attempt, `schema validation failed: ${detail}`, latencyMs);
        correction = `Your previous response was rejected: ${detail}. Correct it and return the whole value again.`;
        continue;
      }

      trajectory.llmCall({
        stage,
        attempt,
        systemHash,
        input: userContent,
        output: validated.data,
        usage,
        costUsd,
        latencyMs,
        stopReason: response.status ?? null,
      });

      return validated.data as ZodInfer<T>;
    } catch (err) {
      if (err instanceof LlmError) throw err;

      const latencyMs = Date.now() - startedAt;

      // The SDK retries 429s, 5xx and connection failures on its own, so
      // anything arriving here has exhausted that. Report it accurately rather
      // than retrying a request that will fail the same way.
      if (err instanceof OpenAI.AuthenticationError) {
        trajectory.llmError(stage, attempt, "authentication failed", latencyMs);
        throw new LlmError("OpenAI rejected the credentials", stage, attempt);
      }
      if (err instanceof OpenAI.RateLimitError) {
        trajectory.llmError(stage, attempt, "rate limited after SDK retries", latencyMs);
        throw new LlmError(`rate limited during ${stage}`, stage, attempt);
      }
      if (err instanceof OpenAI.BadRequestError) {
        // Most often a schema strict mode would not accept. Say so, because
        // the raw message is rarely enough to find the offending field.
        trajectory.llmError(stage, attempt, `bad request: ${err.message}`, latencyMs);
        throw new LlmError(
          `OpenAI rejected the ${stage} request: ${err.message}. ` +
            `If this names a schema keyword, add it to STRIPPED in src/json-schema.ts.`,
          stage,
          attempt,
        );
      }
      if (err instanceof OpenAI.APIError) {
        trajectory.llmError(stage, attempt, `api error ${err.status}: ${err.message}`, latencyMs);
        throw new LlmError(`API error ${err.status} during ${stage}: ${err.message}`, stage, attempt);
      }

      trajectory.llmError(stage, attempt, (err as Error).message, latencyMs);
      throw err;
    }
  }

  throw new LlmError(
    `${stage} did not produce a response matching its schema after ${maxAttempts} attempts`,
    stage,
    maxAttempts,
  );
}

/**
 * Free-text completion. Used only by the baseline, which by design has no
 * schema, no knowledge base and no verifier.
 */
export async function text(opts: {
  stage: string;
  system?: string;
  user: string;
  trajectory: Trajectory;
  maxTokens?: number;
}): Promise<string> {
  const model = currentModel();
  const openai = getClient();
  const system = opts.system ?? "";
  const systemHash = opts.trajectory.prompt(opts.stage, system);
  const startedAt = Date.now();

  const response = await openai.responses.create({
    model,
    ...(system ? { instructions: system } : {}),
    input: opts.user,
    max_output_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
  });

  const latencyMs = Date.now() - startedAt;
  const usage = readUsage(response.usage);

  opts.trajectory.llmCall({
    stage: opts.stage,
    attempt: 1,
    systemHash,
    input: opts.user,
    output: response.output_text,
    usage,
    costUsd: estimateCostUsd(model, usage),
    latencyMs,
    stopReason: response.status ?? null,
  });

  // Same check as structured(). On a reasoning model max_output_tokens covers
  // reasoning *and* visible output, so a budget that looks generous can be
  // spent entirely on thinking - the call then succeeds, bills in full, and
  // returns an empty string. Failing loudly is the only way that is visible.
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason ?? "unknown";
    const spentOnReasoning = usage.reasoningTokens > 0 ? `, ${usage.reasoningTokens} of them on reasoning` : "";
    throw new LlmError(
      `${opts.stage} response was cut off (${reason}) after ${usage.outputTokens} output tokens${spentOnReasoning}. ` +
        `Raise maxTokens.`,
      opts.stage,
      1,
    );
  }

  return response.output_text;
}
