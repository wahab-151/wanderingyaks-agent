import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  saveProposal,
  loadProposal,
  listProposals,
  approve,
  reject,
  send,
  approvals,
  isApproved,
  ReviewError,
  type Proposal,
} from "./review.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");

/**
 * The gate is a ground-rule requirement, not a convenience, so it is tested as
 * one: the interesting assertions are the refusals.
 */

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    runId: "run_test_gate",
    tenantId: "wanderingyaks",
    createdAt: new Date().toISOString(),
    status: "awaiting_review",
    inquiry: "4 friends, Skardu, April",
    brief: {
      groupSize: 4,
      nights: 7,
      startDate: "2026-04-18",
      endDate: "2026-04-25",
      budgetPpUsd: 900,
      nationalities: ["GB"],
      interests: [],
      fitness: "moderate",
      hasChildren: false,
      notes: "",
      missingFields: [],
    },
    draft: {
      title: "Test",
      days: [{ day: 1, location: "skardu", activity: "x", hotelId: null, driveSegments: [], isRestDay: false }],
      assumptions: [],
    },
    costSheet: null,
    violations: [],
    letter: "Dear customer, here is your trip.",
    costSheetText: null,
    ...over,
  };
}

beforeEach(() => {
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
  delete process.env.SEND_MODE;
});
afterEach(() => {
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the human gate", () => {
  it("refuses to send anything that has not been approved", () => {
    saveProposal(proposal());
    expect(() => send({ runId: "run_test_gate", operatorId: "wahab" })).toThrow(/has not been approved/);
  });

  it("refuses to send even when SEND_MODE is live", () => {
    // The gate is not a property of simulation mode. Nothing in the send path
    // can reach a channel without an approval record.
    process.env.SEND_MODE = "live";
    saveProposal(proposal());
    expect(() => send({ runId: "run_test_gate", operatorId: "wahab" })).toThrow(/has not been approved/);
  });

  it("simulates rather than transmits once approved", () => {
    saveProposal(proposal());
    approve({ runId: "run_test_gate", operatorId: "wahab" });
    const result = send({ runId: "run_test_gate", operatorId: "wahab" });
    expect(result.simulated).toBe(true);
  });

  it("refuses live sending because no channel is configured, after recording approval", () => {
    process.env.SEND_MODE = "live";
    saveProposal(proposal());
    approve({ runId: "run_test_gate", operatorId: "wahab" });
    expect(() => send({ runId: "run_test_gate", operatorId: "wahab" })).toThrow(/no outbound channel/);
  });

  it("will not send the same proposal twice", () => {
    saveProposal(proposal());
    approve({ runId: "run_test_gate", operatorId: "wahab" });
    send({ runId: "run_test_gate", operatorId: "wahab" });
    expect(() => send({ runId: "run_test_gate", operatorId: "wahab" })).toThrow(/already sent/);
  });

  it("refuses an approval with no operator id", () => {
    saveProposal(proposal());
    expect(() => approve({ runId: "run_test_gate", operatorId: "   " })).toThrow(/operator id/);
  });

  it("refuses to send a proposal with no letter", () => {
    saveProposal(proposal({ letter: null }));
    approve({ runId: "run_test_gate", operatorId: "wahab" });
    expect(() => send({ runId: "run_test_gate", operatorId: "wahab" })).toThrow(/no letter/);
  });
});

describe("approval records", () => {
  it("attributes every decision to a named person", () => {
    saveProposal(proposal());
    approve({ runId: "run_test_gate", operatorId: "wahab", notes: "swapped Deosai" });

    const history = approvals("run_test_gate");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: "approve", operatorId: "wahab", notes: "swapped Deosai" });
  });

  it("records which violations the operator accepted when approving anyway", () => {
    // An operator may overrule the verifier. That is their call to make, but
    // not their call to make invisibly.
    saveProposal(
      proposal({
        violations: [{ code: "DRIVE_HOURS", day: 3, detail: "7.5h", severity: "hard" }],
      }),
    );
    approve({ runId: "run_test_gate", operatorId: "wahab", notes: "driver is happy with it" });

    const record = approvals("run_test_gate")[0];
    expect(record?.acceptedViolations).toHaveLength(1);
    expect(record?.acceptedViolations[0]?.code).toBe("DRIVE_HOURS");
  });

  it("lets a later rejection revoke an earlier approval", () => {
    saveProposal(proposal());
    approve({ runId: "run_test_gate", operatorId: "wahab" });
    expect(isApproved("run_test_gate")).toBe(true);

    reject({ runId: "run_test_gate", operatorId: "sana", notes: "hotel is closed" });
    expect(isApproved("run_test_gate")).toBe(false);
    expect(() => send({ runId: "run_test_gate", operatorId: "wahab" })).toThrow(/has not been approved/);
  });

  it("keeps the whole decision history, not just the latest", () => {
    saveProposal(proposal());
    approve({ runId: "run_test_gate", operatorId: "wahab" });
    reject({ runId: "run_test_gate", operatorId: "sana" });
    approve({ runId: "run_test_gate", operatorId: "wahab", notes: "fixed" });

    expect(approvals("run_test_gate").map((r) => r.action)).toEqual(["approve", "reject", "approve"]);
    expect(isApproved("run_test_gate")).toBe(true);
  });

  it("refuses to change approval on something already sent", () => {
    saveProposal(proposal());
    approve({ runId: "run_test_gate", operatorId: "wahab" });
    send({ runId: "run_test_gate", operatorId: "wahab" });
    expect(() => approve({ runId: "run_test_gate", operatorId: "wahab" })).toThrow(/already been sent/);
  });
});

describe("proposal storage", () => {
  it("round-trips a proposal", () => {
    saveProposal(proposal());
    expect(loadProposal("run_test_gate").inquiry).toContain("Skardu");
  });

  it("reports a missing proposal rather than returning an empty one", () => {
    expect(() => loadProposal("run_does_not_exist")).toThrow(/no proposal found/);
  });

  it("rejects a run id that could escape the data directory", () => {
    expect(() => loadProposal("../../etc/passwd")).toThrow(/invalid run id/);
  });

  it("filters by status", () => {
    saveProposal(proposal({ runId: "run_a" }));
    saveProposal(proposal({ runId: "run_b" }));
    approve({ runId: "run_b", operatorId: "wahab" });

    expect(listProposals("awaiting_review").map((p) => p.runId)).toEqual(["run_a"]);
    expect(listProposals()).toHaveLength(2);
  });

  it("moves a proposal through its statuses", () => {
    saveProposal(proposal());
    expect(loadProposal("run_test_gate").status).toBe("awaiting_review");
    approve({ runId: "run_test_gate", operatorId: "wahab" });
    expect(loadProposal("run_test_gate").status).toBe("approved");
    send({ runId: "run_test_gate", operatorId: "wahab" });
    expect(loadProposal("run_test_gate").status).toBe("sent");
  });
});
