import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { ZodType, infer as ZodInfer } from "zod";
import { Trajectory, estimateCostUsd, type TokenUsage } from "./trajectory.js";

/**
 * The only file in the project that talks to a model.
 *
 * Every stage that needs the model goes through structured(), so trajectory
 * logging, cost accounting, prompt caching and schema validation are decided
 * once rather than repeated - and none of them can be forgotten in a new stage.
 *
 * Structured output is enforced by the API through output_config, not by asking
 * for JSON in prose and hoping. A response that does not satisfy the schema
 * never reaches a caller: it is retried with the validation error fed back, and
 * every attempt is logged.
 */

export const DEFAULT_MODEL = "claude-opus-5";
export const MAX_TOKENS = 16_000;

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

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new LlmError(
      "No Anthropic credentials found. Set ANTHROPIC_API_KEY in .env (copy .env.example), " +
        "or run `ant auth login`. The knowledge base and verifier run without a key; " +
        "only the model stages need one.",
      "init",
      0,
    );
  }
  client = new Anthropic();
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
  /** Stable instructions. Identical across cases, so this is the cached prefix. */
  system: string;
  /** Case-specific input. Never put stable text here or the cache never hits. */
  user: string;
  trajectory: Trajectory;
  /** Attempts allowed if the model returns something the schema rejects. */
  maxAttempts?: number;
  /** Omitted means the model default. SDK 0.71 accepts low/medium/high only. */
  effort?: "low" | "medium" | "high";
}

function readUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * One model call returning a value that satisfies `schema`.
 *
 * The system prompt is sent as a cached block. Across an evaluation run the
 * instructions are byte-identical from case to case while only the user turn
 * changes, so the prefix should be served from cache after the first call.
 * Whether it actually is shows up as cacheReadTokens in the trajectory - if
 * that stays at zero, something in the "stable" half is not stable.
 */
export async function structured<T extends ZodType>(
  opts: StructuredOptions<T>,
): Promise<ZodInfer<T>> {
  const { stage, schema, system, user, trajectory } = opts;
  const maxAttempts = opts.maxAttempts ?? 2;
  const model = currentModel();
  const anthropic = getClient();
  const systemHash = trajectory.prompt(stage, system);

  let correction = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    const userContent = correction ? `${user}\n\n${correction}` : user;

    try {
      const response = await anthropic.beta.messages.parse({
        model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent }],
        output_format: betaZodOutputFormat(schema),
        ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
      });

      const latencyMs = Date.now() - startedAt;
      const usage = readUsage(response.usage);
      const costUsd = estimateCostUsd(model, usage);

      // A safety decline arrives as a normal 200 with no usable content, so
      // stop_reason has to be checked before the payload is read.
      if (response.stop_reason === "refusal") {
        trajectory.llmError(stage, attempt, "model declined the request", latencyMs);
        throw new LlmError(`model declined the ${stage} request`, stage, attempt);
      }

      const parsed = response.parsed_output;
      if (parsed == null) {
        // The API constrains the format, so this is rare - but a null here
        // silently becoming an empty object downstream would be much worse.
        trajectory.llmError(stage, attempt, "response did not parse against the schema", latencyMs);
        correction =
          "Your previous response did not match the required output format. " +
          "Return only a value satisfying the schema.";
        continue;
      }

      // The API-side constraint and this check are deliberately redundant.
      // Refinements the JSON Schema cannot express - a date pattern, a
      // positive integer - are only caught here.
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
        stopReason: response.stop_reason ?? null,
      });

      return validated.data as ZodInfer<T>;
    } catch (err) {
      if (err instanceof LlmError) throw err;

      const latencyMs = Date.now() - startedAt;

      // The SDK already retries 429s, 5xx and connection failures on its own,
      // so anything arriving here has exhausted that. Report it accurately
      // rather than retrying a request that will fail the same way.
      if (err instanceof Anthropic.AuthenticationError) {
        trajectory.llmError(stage, attempt, "authentication failed", latencyMs);
        throw new LlmError("Anthropic rejected the credentials", stage, attempt);
      }
      if (err instanceof Anthropic.RateLimitError) {
        trajectory.llmError(stage, attempt, "rate limited after SDK retries", latencyMs);
        throw new LlmError(`rate limited during ${stage}`, stage, attempt);
      }
      if (err instanceof Anthropic.APIError) {
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
  const anthropic = getClient();
  const system = opts.system ?? "";
  const systemHash = opts.trajectory.prompt(opts.stage, system);
  const startedAt = Date.now();

  const response = await anthropic.messages.create({
    model,
    max_tokens: opts.maxTokens ?? MAX_TOKENS,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: opts.user }],
  });

  const latencyMs = Date.now() - startedAt;
  const usage = readUsage(response.usage);
  const out = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  opts.trajectory.llmCall({
    stage: opts.stage,
    attempt: 1,
    systemHash,
    input: opts.user,
    output: out,
    usage,
    costUsd: estimateCostUsd(model, usage),
    latencyMs,
    stopReason: response.stop_reason ?? null,
  });

  return out;
}
