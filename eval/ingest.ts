import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWhatsAppExport, anonymiseThread, participants } from "../src/anonymise.js";

const here = dirname(fileURLToPath(import.meta.url));
const STAGING_DIR = join(here, "cases-staging");

/**
 * Turns exported WhatsApp threads into draft evaluation cases.
 *
 *   npm run ingest -- --from path/to/export.txt --operator "Wandering Yaks"
 *   npm run ingest -- --from path/to/folder/    --operator "Wandering Yaks"
 *
 * WHY IT WRITES TO A STAGING DIRECTORY
 *
 * This tool never writes into eval/cases/. It writes drafts to
 * eval/cases-staging/, which is gitignored, and a human moves them across after
 * reading each one.
 *
 * That is not caution for its own sake. Ground rule 07 governs real customer
 * data, the scrubber is a pattern matcher, and pattern matchers miss things -
 * a name spelled unusually, a phone number written in words, a detail that only
 * identifies someone if you already know the context. The person who ran the
 * trip can see those in seconds and no regular expression can. So the tool does
 * the mechanical 90% and hands the judgement to someone who has it.
 *
 * Each draft carries a `_review` block listing what was redacted and what the
 * scrubber suspected but did not touch. Clear that block, fill in the brief and
 * ground truth, then move the file.
 */

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : null;
}

function exportFiles(from: string): string[] {
  if (!existsSync(from)) {
    console.error(`\nNo such file or directory: ${from}\n`);
    process.exit(1);
  }
  if (!statSync(from).isDirectory()) return [from];
  return readdirSync(from)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => join(from, f))
    .sort();
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function main(): void {
  const from = flag("from");
  const operator = flag("operator");

  if (!from) {
    console.error(
      "\nUsage:\n" +
        '  npm run ingest -- --from <export.txt|folder> --operator "Your Company Name"\n\n' +
        "--operator is the sender name your side uses in the WhatsApp thread. Their\n" +
        "messages are dropped, because the operator's reply contains the answer the\n" +
        "agent is supposed to work out for itself.\n",
    );
    process.exit(1);
  }
  if (!operator) {
    console.error(
      "\n--operator is required. Without it the tool cannot tell the customer's\n" +
        "messages from your replies, and including your replies would leak the\n" +
        "expected itinerary into the enquiry the agent is scored on.\n",
    );
    process.exit(1);
  }

  if (!existsSync(STAGING_DIR)) mkdirSync(STAGING_DIR, { recursive: true });

  const files = exportFiles(from);
  console.log(`\n${files.length} export file(s)\n`);

  let written = 0;
  let flagged = 0;

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const messages = parseWhatsAppExport(raw);

    if (messages.length === 0) {
      console.log(`  ${basename(file).padEnd(40)} no messages parsed - unrecognised format?`);
      continue;
    }

    const everyone = participants(messages);
    const thread = anonymiseThread(messages, [operator]);

    if (thread.inquiry.trim() === "") {
      console.log(`  ${basename(file).padEnd(40)} nothing left after removing operator messages`);
      continue;
    }

    const id = `case-real-${slug(basename(file, ".txt"))}`;
    const draft = {
      id,
      provenance: "anonymised-real",
      difficulty: "moderate",
      inquiry: thread.inquiry,
      today: "TODO-YYYY-MM-DD",
      brief: {
        groupSize: 0,
        nights: 0,
        startDate: null,
        endDate: null,
        budgetPpUsd: null,
        nationalities: [],
        interests: [],
        fitness: "low",
        hasChildren: false,
        notes: "TODO: what a careful person would extract from this enquiry",
        missingFields: [],
      },
      notes: "TODO: what makes this case interesting, and what the operator actually did",
      groundTruth: {
        operatorItinerary: null,
        quotedTotalUsd: null,
        operatorMinutesSpent: null,
      },
      _review: {
        WARNING:
          "This file is a draft. Read every line before moving it to eval/cases/. " +
          "Delete this _review block once you have. Loading will reject the case while " +
          "today or the brief still says TODO.",
        sourceFile: basename(file),
        messagesKept: thread.messageCount,
        participantsSeen: everyone,
        redactionsApplied: thread.redactions.map((r) => `${r.kind}: ${r.replacement}`),
        pseudonyms: thread.nameMap.map(([real, fake]) => `${real} -> ${fake}`),
        suspectedNamesNotRedacted: thread.suspectedNames,
      },
    };

    writeFileSync(join(STAGING_DIR, `${id}.json`), JSON.stringify(draft, null, 2) + "\n", "utf8");
    written += 1;
    if (thread.suspectedNames.length > 0) flagged += 1;

    console.log(
      `  ${basename(file).padEnd(40)} ${String(thread.messageCount).padStart(3)} msgs, ` +
        `${String(thread.redactions.length).padStart(3)} redactions` +
        (thread.suspectedNames.length
          ? `, ${thread.suspectedNames.length} possible name(s) NOT redacted: ${thread.suspectedNames.join(", ")}`
          : ""),
    );
  }

  console.log(`\n${written} draft(s) written to eval/cases-staging/`);
  if (flagged > 0) {
    console.log(
      `${flagged} contain capitalised words that may be people. They were left in place\n` +
        `deliberately - deleting a place name silently breaks the case, so the call is yours.`,
    );
  }

  console.log(
    `\nNext:\n` +
      `  1. Read every draft. Check the inquiry text line by line.\n` +
      `  2. Fill in "today", the brief, and groundTruth from what you actually sent.\n` +
      `  3. Delete the _review block.\n` +
      `  4. Move the file into eval/cases/ and run: npm test\n\n` +
      `Nothing in eval/cases-staging/ is committed - it is gitignored.\n`,
  );

}

main();
