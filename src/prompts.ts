import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = join(here, "prompts");

/**
 * Prompts live as files, not string literals, for two reasons: they are the
 * "instructions that shape each agent" the submission has to include, and the
 * changelog will record several rounds of tuning them. A prompt buried in a
 * template literal is a prompt nobody diffs.
 *
 * Loaded once and cached, because the text must be byte-identical across calls
 * for the cached prefix in llm.ts to hit.
 */
const cache = new Map<string, string>();

export function loadPrompt(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const path = join(PROMPT_DIR, `${name}.md`);
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`missing prompt file: src/prompts/${name}.md`);
  }
  cache.set(name, text);
  return text;
}
