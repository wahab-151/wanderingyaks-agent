/**
 * Strips personal information out of real customer conversations.
 *
 * Ground rule 07 allows only data you are permitted to share, and a hackathon
 * repository that judges will read is about as public as a thing gets. The real
 * evaluation cases come from WhatsApp threads with actual customers, so nothing
 * from those threads can enter the repository unscrubbed.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is a first pass that removes the obvious identifiers reliably. It is not a
 * guarantee, and it is deliberately not treated as one: `ingest` writes to a
 * staging directory and refuses to write into `eval/cases/`, so a human reads
 * every case before it is committed. Automated scrubbing alone is not a
 * defensible standard for someone else's personal data.
 *
 * WHAT IS DELIBERATELY KEPT
 *
 * Nationality, party size, dates, budget and destinations all survive, because
 * they are what the brief is made of and none of them identify anyone on their
 * own. Nationality in particular drives permit rules, so removing it would make
 * the case useless for the thing it is meant to test.
 */

export interface Redaction {
  kind: "name" | "phone" | "email" | "url" | "id_number" | "handle";
  original: string;
  replacement: string;
}

export interface AnonymisedText {
  text: string;
  redactions: Redaction[];
  /** Terms that look like names but were not in the participant roster. */
  suspectedNames: string[];
}

/**
 * Patterns are ordered most specific first. An email contains something that
 * looks like a handle, and a CNIC contains something that looks like a phone
 * number, so a looser pattern running first would corrupt the stricter one.
 */
const PATTERNS: { kind: Redaction["kind"]; re: RegExp; label: string }[] = [
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: "EMAIL" },
  { kind: "url", re: /\bhttps?:\/\/\S+/gi, label: "URL" },
  // Pakistani CNIC: 12345-1234567-1
  { kind: "id_number", re: /\b\d{5}-\d{7}-\d\b/g, label: "ID" },
  // Passport-like: two letters then six or more digits
  { kind: "id_number", re: /\b[A-Z]{2}\d{6,9}\b/g, label: "ID" },
  // Phone numbers: international, local Pakistani, and spaced or dashed forms.
  { kind: "phone", re: /\+\d[\d\s().-]{7,}\d/g, label: "PHONE" },
  { kind: "phone", re: /\b0\d{2,4}[\s-]?\d{6,8}\b/g, label: "PHONE" },
  { kind: "phone", re: /\b\d{4}[\s-]\d{7}\b/g, label: "PHONE" },
  { kind: "handle", re: /(?<![A-Za-z0-9._%+-])@[A-Za-z0-9._]{3,}/g, label: "HANDLE" },
];

/**
 * Words that look like capitalised names but are places, months or common
 * sentence openers. Redacting these would destroy the case: "Skardu" and
 * "April" are exactly what the brief needs.
 */
const NOT_NAMES = new Set(
  [
    // months and days
    "january","february","march","april","may","june","july","august","september","october","november","december",
    "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
    // places the knowledge base cares about
    "pakistan","islamabad","lahore","karachi","skardu","hunza","gilgit","khaplu","shigar","deosai","kachura",
    "chilas","astore","naltar","nagar","passu","gulmit","sost","khunjerab","shimshal","karimabad","attabad",
    "fairy","meadows","nanga","parbat","rakaposhi","baltistan","karakoram","hindukush","chitral","kalash",
    "hushe","kharmang","basho","borith","minapin","duikar","ganish","naran","babusar","sadpara","manthokha",
    "baltit","altit","katpana","shangrila","indus","shyok","masherbrum","k2","rush","patundas","kaghan",
    // nationalities and languages, which are kept on purpose
    "british","american","australian","canadian","german","dutch","french","indian","pakistani","chinese",
    "japanese","italian","spanish","swiss","english","urdu",
    // frequent sentence openers and filler
    "hi","hello","salam","assalam","thanks","thank","regards","dear","good","morning","afternoon","evening",
    "we","i","my","our","the","and","but","so","also","just","actually","sorry","please","yes","no","ok","okay",
    "budget","days","nights","people","friends","family","trip","tour","travel","holiday","week","weeks","month",
  ].map((w) => w.toLowerCase()),
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Assigns stable pseudonyms. The same real person is always the same Customer
 * within one thread, so the conversation still reads as a conversation - which
 * matters, because an eval case where every speaker is "REDACTED" no longer
 * tests whether intake can follow a thread.
 */
export class NameMap {
  private readonly map = new Map<string, string>();
  private next = 0;

  pseudonymFor(realName: string): string {
    const key = realName.trim().toLowerCase();
    const existing = this.map.get(key);
    if (existing) return existing;

    const letter = String.fromCharCode(65 + (this.next % 26));
    const suffix = this.next >= 26 ? String(Math.floor(this.next / 26) + 1) : "";
    this.next += 1;
    const pseudonym = `Customer ${letter}${suffix}`;
    this.map.set(key, pseudonym);
    return pseudonym;
  }

  get entries(): [string, string][] {
    return [...this.map.entries()];
  }
}

/**
 * Finds capitalised words that are probably personal names and are not in the
 * roster of known participants. These are reported rather than redacted: a
 * human decides, because the cost of silently deleting a place name is a
 * broken eval case and the cost of silently keeping a name is a privacy breach.
 * Neither should be decided by a regular expression.
 */
export function suspectedNames(text: string, known: Set<string>): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (NOT_NAMES.has(lower)) continue;
    if (known.has(lower)) continue;
    found.add(word);
  }
  return [...found].sort();
}

export function anonymiseText(
  input: string,
  names: NameMap,
  participantNames: string[] = [],
): AnonymisedText {
  const redactions: Redaction[] = [];
  let text = input;

  // Participant names first, longest first so "Ali Raza" is replaced before
  // "Ali" can partially match inside it.
  const sorted = [...participantNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (name.trim().length < 2) continue;
    const re = new RegExp(escapeRegExp(name), "gi");
    if (!re.test(text)) continue;

    // The pseudonym is claimed only once the name is known to be present.
    // Assigning one up front would list people in the name map who were never
    // actually redacted, which makes the report a human reads to check the
    // work say more happened than did.
    const pseudonym = names.pseudonymFor(name);
    text = text.replace(re, pseudonym);
    redactions.push({ kind: "name", original: name, replacement: pseudonym });
  }

  for (const { kind, re, label } of PATTERNS) {
    text = text.replace(re, (match) => {
      redactions.push({ kind, original: match, replacement: `[${label}]` });
      return `[${label}]`;
    });
  }

  const known = new Set(participantNames.map((n) => n.toLowerCase()));
  return { text, redactions, suspectedNames: suspectedNames(text, known) };
}

// ---------------------------------------------------------------------------
// WhatsApp export parsing
// ---------------------------------------------------------------------------

export interface ChatMessage {
  at: string;
  sender: string;
  text: string;
}

/**
 * WhatsApp exports vary by platform and locale. Two shapes cover the common
 * cases:
 *
 *   [12/04/2026, 14:32:11] Ali Raza: message text
 *   12/04/2026, 14:32 - Ali Raza: message text
 *
 * A line that matches neither is a continuation of the previous message, which
 * is how multi-line messages arrive.
 */
const LINE_PATTERNS = [
  /^\[(?<date>[^\],]+),\s*(?<time>[^\]]+)\]\s*(?<sender>[^:]+):\s?(?<text>.*)$/,
  /^(?<date>\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(?<time>[\d:]+(?:\s*[apAP][mM])?)\s*-\s*(?<sender>[^:]+):\s?(?<text>.*)$/,
];

/** Lines WhatsApp inserts itself, which are not part of the conversation. */
const SYSTEM_LINE =
  /(Messages and calls are end-to-end encrypted|You deleted this message|This message was deleted|<Media omitted>|joined using this group|changed the subject|changed this group's icon|created group)/i;

export function parseWhatsAppExport(raw: string): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const line of raw.split(/\r?\n/)) {
    let matched = false;

    for (const pattern of LINE_PATTERNS) {
      const m = line.match(pattern);
      if (!m?.groups) continue;
      matched = true;

      const date = m.groups["date"] ?? "";
      const time = m.groups["time"] ?? "";
      const sender = m.groups["sender"] ?? "";
      const text = m.groups["text"] ?? "";

      if (SYSTEM_LINE.test(text) || SYSTEM_LINE.test(sender)) break;
      messages.push({ at: `${date.trim()} ${time.trim()}`, sender: sender.trim(), text: text.trim() });
      break;
    }

    if (!matched && messages.length > 0 && line.trim() !== "") {
      if (SYSTEM_LINE.test(line)) continue;
      const last = messages[messages.length - 1]!;
      last.text = `${last.text}\n${line.trim()}`.trim();
    }
  }

  return messages;
}

/** Who is the customer, as opposed to the operator answering them. */
export function participants(messages: ChatMessage[]): string[] {
  return [...new Set(messages.map((m) => m.sender))];
}

export interface AnonymisedThread {
  /** The conversation as the customer wrote it, scrubbed. */
  inquiry: string;
  messageCount: number;
  redactions: Redaction[];
  suspectedNames: string[];
  nameMap: [string, string][];
}

/**
 * Turns one exported thread into the `inquiry` field of an evaluation case.
 *
 * Only the customer's own messages are kept. The operator's replies are the
 * answer, and including them would leak the expected output into the input -
 * the agent would be scored on a thread that already contains the itinerary.
 */
export function anonymiseThread(
  messages: ChatMessage[],
  operatorSenders: string[] = [],
): AnonymisedThread {
  const names = new NameMap();
  const everyone = participants(messages);
  const operators = new Set(operatorSenders.map((s) => s.trim().toLowerCase()));
  const customerMessages = messages.filter((m) => !operators.has(m.sender.trim().toLowerCase()));

  const redactions: Redaction[] = [];
  const suspected = new Set<string>();
  const lines: string[] = [];

  for (const m of customerMessages) {
    const result = anonymiseText(m.text, names, everyone);
    redactions.push(...result.redactions);
    result.suspectedNames.forEach((n) => suspected.add(n));
    lines.push(result.text);
  }

  return {
    inquiry: lines.join("\n\n").trim(),
    messageCount: customerMessages.length,
    redactions,
    suspectedNames: [...suspected].sort(),
    nameMap: names.entries,
  };
}
