import { describe, it, expect } from "vitest";
import {
  anonymiseText,
  anonymiseThread,
  parseWhatsAppExport,
  participants,
  suspectedNames,
  NameMap,
} from "./anonymise.js";

/**
 * These tests are about someone else's personal data reaching a public
 * repository, so they are written as a checklist of what must never survive
 * and what must never be destroyed. Both directions matter: a scrubber that
 * eats "Skardu" and "April" produces an evaluation case that tests nothing.
 */

describe("what must not survive", () => {
  const scrub = (text: string) => anonymiseText(text, new NameMap(), []).text;

  it("removes email addresses", () => {
    expect(scrub("write to me at ali.raza@example.com please")).not.toMatch(/ali\.raza|example\.com/);
  });

  it("removes international phone numbers", () => {
    expect(scrub("call +92 300 1234567 any time")).not.toMatch(/\d{7}/);
  });

  it("removes local phone numbers", () => {
    expect(scrub("my number is 0300 1234567")).not.toMatch(/1234567/);
  });

  it("removes dashed phone numbers", () => {
    expect(scrub("reach me on 0345-1234567")).not.toMatch(/1234567/);
  });

  it("removes a Pakistani CNIC", () => {
    expect(scrub("my cnic is 35202-1234567-1")).not.toMatch(/35202|1234567/);
  });

  it("removes a passport number", () => {
    expect(scrub("passport AB1234567 expires next year")).not.toMatch(/AB1234567/);
  });

  it("removes URLs, which often carry identifiers", () => {
    expect(scrub("see https://facebook.com/ali.raza.123 for photos")).not.toMatch(/facebook|ali\.raza/);
  });

  it("removes social handles", () => {
    expect(scrub("find me @aliraza_travels on instagram")).not.toMatch(/aliraza_travels/);
  });

  it("removes a participant name wherever it appears in the text", () => {
    const result = anonymiseText("Ali said he would come, and Ali is bringing his brother", new NameMap(), ["Ali"]);
    expect(result.text).not.toMatch(/Ali\b/);
    expect(result.text).toMatch(/Customer A/);
  });

  it("removes a full name before it can partially match", () => {
    // "Ali Raza" must go before "Ali" leaves a dangling "Raza" behind.
    const result = anonymiseText("Ali Raza will pay the deposit", new NameMap(), ["Ali", "Ali Raza"]);
    expect(result.text).not.toMatch(/Raza/);
  });
});

describe("what must not be destroyed", () => {
  const scrub = (text: string) => anonymiseText(text, new NameMap(), []).text;

  it("keeps destinations, which are the point of the case", () => {
    const text = "We want Skardu and Hunza, maybe Deosai if it is open";
    expect(scrub(text)).toBe(text);
  });

  it("keeps dates and months", () => {
    const text = "We are thinking late April or early May";
    expect(scrub(text)).toBe(text);
  });

  it("keeps nationality, which drives permit rules", () => {
    const text = "Two of us are British and two are Australian";
    expect(scrub(text)).toBe(text);
  });

  it("keeps party size and budget", () => {
    const text = "There are 4 of us and our budget is around 900 dollars each";
    expect(scrub(text)).toBe(text);
  });

  it("does not mistake a year for a phone number", () => {
    expect(scrub("we travelled there in 2024")).toMatch(/2024/);
  });

  it("keeps a whole realistic enquiry intact", () => {
    const text =
      "Hi, we are 4 friends looking to visit Skardu for about 8 days in late April. " +
      "Budget is around $900 each. We would love to see the Deosai plains. Two of us are British.";
    expect(scrub(text)).toBe(text);
  });
});

describe("names that need a human", () => {
  it("reports capitalised words that are not known participants", () => {
    const found = suspectedNames("Please ask Bashir about the jeep", new Set());
    expect(found).toContain("Bashir");
  });

  it("does not report place names as suspected people", () => {
    const found = suspectedNames("We want Skardu, Hunza and Karimabad in September", new Set());
    expect(found).toEqual([]);
  });

  it("does not report a name it already redacted", () => {
    const result = anonymiseText("Ali will travel with us", new NameMap(), ["Ali"]);
    expect(result.suspectedNames).not.toContain("Ali");
  });

  it("surfaces them rather than deleting them, because the call is not a regex's to make", () => {
    const result = anonymiseText("Bashir is our driver from last time", new NameMap(), []);
    expect(result.text).toMatch(/Bashir/); // still present
    expect(result.suspectedNames).toContain("Bashir"); // and flagged
  });
});

describe("pseudonyms are stable", () => {
  it("gives the same person the same pseudonym throughout a thread", () => {
    const names = new NameMap();
    expect(names.pseudonymFor("Ali Raza")).toBe(names.pseudonymFor("ali raza"));
  });

  it("gives different people different pseudonyms", () => {
    const names = new NameMap();
    expect(names.pseudonymFor("Ali")).not.toBe(names.pseudonymFor("Sana"));
  });

  it("keeps the conversation readable as a conversation", () => {
    // An eval case where every speaker is REDACTED no longer tests whether
    // intake can follow a thread.
    const names = new NameMap();
    expect(names.pseudonymFor("Ali")).toBe("Customer A");
    expect(names.pseudonymFor("Sana")).toBe("Customer B");
  });
});

describe("WhatsApp export parsing", () => {
  const bracketed = `[12/04/2026, 14:32:11] Ali Raza: Hi, we are 4 friends
[12/04/2026, 14:32:40] Ali Raza: looking at Skardu in late April
[12/04/2026, 14:35:02] Wandering Yaks: Thanks for getting in touch
[12/04/2026, 14:36:10] Ali Raza: budget is about 900 each`;

  const dashed = `12/04/2026, 2:32 PM - Ali Raza: Hi, we are 4 friends
12/04/2026, 2:35 PM - Wandering Yaks: Thanks for getting in touch`;

  it("parses the bracketed export format", () => {
    const messages = parseWhatsAppExport(bracketed);
    expect(messages).toHaveLength(4);
    expect(messages[0]?.sender).toBe("Ali Raza");
    expect(messages[0]?.text).toBe("Hi, we are 4 friends");
  });

  it("parses the dashed export format", () => {
    const messages = parseWhatsAppExport(dashed);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.sender).toBe("Wandering Yaks");
  });

  it("joins continuation lines onto the message they belong to", () => {
    const messages = parseWhatsAppExport(
      `[12/04/2026, 14:32:11] Ali: first line\nsecond line\nthird line`,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("first line\nsecond line\nthird line");
  });

  it("drops WhatsApp's own system lines", () => {
    const messages = parseWhatsAppExport(
      `[12/04/2026, 14:00:00] Ali: Messages and calls are end-to-end encrypted.\n[12/04/2026, 14:32:11] Ali: real message`,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("real message");
  });

  it("drops omitted media rather than leaving a placeholder in the enquiry", () => {
    const messages = parseWhatsAppExport(`[12/04/2026, 14:00:00] Ali: <Media omitted>`);
    expect(messages).toHaveLength(0);
  });

  it("lists everyone who spoke", () => {
    expect(participants(parseWhatsAppExport(bracketed)).sort()).toEqual(["Ali Raza", "Wandering Yaks"]);
  });
});

describe("turning a thread into an evaluation case", () => {
  const raw = `[12/04/2026, 14:32:11] Ali Raza: Hi, we are 4 friends looking at Skardu
[12/04/2026, 14:33:00] Ali Raza: late April, budget 900 each, call me on 0300 1234567
[12/04/2026, 14:34:00] Ali Raza: this is Ali Raza by the way, Sana is booking for us
[12/04/2026, 14:35:02] Wandering Yaks: Thanks Ali, Deosai is under snow then - I suggest Khaplu instead
[12/04/2026, 14:36:10] Ali Raza: ok that sounds good`;

  it("keeps only the customer's messages", () => {
    const thread = anonymiseThread(parseWhatsAppExport(raw), ["Wandering Yaks"]);
    expect(thread.messageCount).toBe(4);
  });

  it("does not leak the operator's answer into the input", () => {
    // The operator's reply contains the substitution the agent is supposed to
    // work out for itself. Including it would score the agent on a thread that
    // already holds the answer.
    const thread = anonymiseThread(parseWhatsAppExport(raw), ["Wandering Yaks"]);
    expect(thread.inquiry).not.toMatch(/Khaplu/);
    expect(thread.inquiry).not.toMatch(/under snow/);
  });

  it("scrubs the customer's own messages", () => {
    const thread = anonymiseThread(parseWhatsAppExport(raw), ["Wandering Yaks"]);
    expect(thread.inquiry).not.toMatch(/1234567/);
    expect(thread.inquiry).not.toMatch(/Ali/);
  });

  it("keeps what the brief is made of", () => {
    const thread = anonymiseThread(parseWhatsAppExport(raw), ["Wandering Yaks"]);
    expect(thread.inquiry).toMatch(/Skardu/);
    expect(thread.inquiry).toMatch(/April/);
    expect(thread.inquiry).toMatch(/900/);
    expect(thread.inquiry).toMatch(/4 friends/);
  });

  it("reports what it redacted, so a human can check the work", () => {
    const thread = anonymiseThread(parseWhatsAppExport(raw), ["Wandering Yaks"]);
    expect(thread.redactions.some((r) => r.kind === "phone")).toBe(true);
    expect(thread.redactions.some((r) => r.kind === "name")).toBe(true);
    expect(thread.nameMap.length).toBeGreaterThan(0);
  });
});
