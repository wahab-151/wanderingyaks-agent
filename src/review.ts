import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Brief, CostSheet, DraftItinerary, Violation } from "./schemas.js";
import type { Trajectory } from "./trajectory.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const PROPOSAL_DIR = join(DATA_DIR, "proposals");
const APPROVAL_LOG = join(DATA_DIR, "approvals.jsonl");

/**
 * The human gate.
 *
 * Ground rules 04 and 05: a consequential action is sandboxed and requires a
 * recorded human approval, and a qualified reviewer is part of any workflow
 * that could affect someone. Sending a quote to a real customer is exactly
 * that - it commits the operator to a price and a set of dates.
 *
 * Two properties matter and both are enforced here rather than by convention:
 *
 *   1. Approval and sending are separate operations. Approval records a human
 *      decision; sending performs the outbound action. A bug in sending cannot
 *      manufacture an approval, because they touch different records.
 *
 *   2. There is no flag that bypasses the gate. `SEND_MODE=live` still requires
 *      an approval record to exist. The only way past `send()` is for a named
 *      operator to have approved that specific proposal.
 *
 * Storage is plain JSON rather than SQLite: no native dependency, so a clean
 * clone runs with `npm install` alone, which is what reproducibility costs.
 */

export const ProposalStatus = z.enum(["awaiting_review", "approved", "rejected", "sent"]);

export const Proposal = z.object({
  runId: z.string(),
  tenantId: z.string(),
  createdAt: z.string(),
  status: ProposalStatus,
  inquiry: z.string(),
  brief: Brief,
  draft: DraftItinerary,
  costSheet: CostSheet.nullable(),
  violations: z.array(Violation),
  /** The customer-facing letter. Null when render was skipped. */
  letter: z.string().nullable(),
  costSheetText: z.string().nullable(),
});

export type Proposal = z.infer<typeof Proposal>;

export const ApprovalRecord = z.object({
  runId: z.string(),
  action: z.enum(["approve", "reject", "send"]),
  operatorId: z.string(),
  at: z.string(),
  notes: z.string().nullable(),
  /** Violations outstanding at the moment of approval, recorded verbatim. */
  acceptedViolations: z.array(Violation).default([]),
  sendMode: z.string().nullable(),
});

export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

function ensureDirs(): void {
  if (!existsSync(PROPOSAL_DIR)) mkdirSync(PROPOSAL_DIR, { recursive: true });
}

function proposalPath(runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new ReviewError(`invalid run id: ${runId}`);
  return join(PROPOSAL_DIR, `${runId}.json`);
}

export function saveProposal(p: Proposal): string {
  ensureDirs();
  const path = proposalPath(p.runId);
  writeFileSync(path, JSON.stringify(p, null, 2), "utf8");
  return path;
}

export function loadProposal(runId: string): Proposal {
  const path = proposalPath(runId);
  if (!existsSync(path)) throw new ReviewError(`no proposal found for run ${runId}`);
  const parsed = Proposal.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new ReviewError(`proposal ${runId} is malformed: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

export function listProposals(status?: z.infer<typeof ProposalStatus>): Proposal[] {
  ensureDirs();
  return readdirSync(PROPOSAL_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const parsed = Proposal.safeParse(JSON.parse(readFileSync(join(PROPOSAL_DIR, f), "utf8")));
      return parsed.success ? parsed.data : null;
    })
    .filter((p): p is Proposal => p !== null)
    .filter((p) => (status ? p.status === status : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function record(entry: ApprovalRecord): void {
  ensureDirs();
  appendFileSync(APPROVAL_LOG, `${JSON.stringify(entry)}\n`, "utf8");
}

export function approvals(runId: string): ApprovalRecord[] {
  if (!existsSync(APPROVAL_LOG)) return [];
  return readFileSync(APPROVAL_LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => ApprovalRecord.safeParse(JSON.parse(line)))
    .filter((r): r is { success: true; data: ApprovalRecord } => r.success)
    .map((r) => r.data)
    .filter((r) => r.runId === runId);
}

export function isApproved(runId: string): boolean {
  const history = approvals(runId);
  // Read forward: a later rejection revokes an earlier approval.
  let approved = false;
  for (const r of history) {
    if (r.action === "approve") approved = true;
    if (r.action === "reject") approved = false;
  }
  return approved;
}

/**
 * Records a human decision. The operator id is required and not defaulted -
 * an approval that cannot be attributed to a person is not an approval.
 */
export function approve(args: {
  runId: string;
  operatorId: string;
  notes?: string;
  trajectory?: Trajectory;
}): Proposal {
  const { runId, operatorId } = args;
  if (!operatorId.trim()) throw new ReviewError("approval requires an operator id");

  const proposal = loadProposal(runId);
  if (proposal.status === "sent") {
    throw new ReviewError(`run ${runId} has already been sent; approval cannot be changed`);
  }

  const outstanding = proposal.violations.filter((v) => v.severity === "hard");
  record({
    runId,
    action: "approve",
    operatorId,
    at: new Date().toISOString(),
    notes: args.notes ?? null,
    // If the operator approves something the verifier still objects to, that
    // decision is recorded with the objections attached. It is theirs to make;
    // it is not theirs to make invisibly.
    acceptedViolations: outstanding,
    sendMode: null,
  });

  args.trajectory?.human("approve", operatorId, args.notes);

  const updated: Proposal = { ...proposal, status: "approved" };
  saveProposal(updated);
  return updated;
}

export function reject(args: {
  runId: string;
  operatorId: string;
  notes?: string;
  trajectory?: Trajectory;
}): Proposal {
  const proposal = loadProposal(args.runId);
  record({
    runId: args.runId,
    action: "reject",
    operatorId: args.operatorId,
    at: new Date().toISOString(),
    notes: args.notes ?? null,
    acceptedViolations: [],
    sendMode: null,
  });
  args.trajectory?.human("reject", args.operatorId, args.notes);

  const updated: Proposal = { ...proposal, status: "rejected" };
  saveProposal(updated);
  return updated;
}

export interface SendResult {
  simulated: boolean;
  runId: string;
  sentAt: string;
}

/**
 * The consequential action.
 *
 * Refuses without a recorded approval regardless of SEND_MODE. There is
 * deliberately no override parameter: the check is the first thing the function
 * does and nothing in the signature can skip it.
 */
export function send(args: { runId: string; operatorId: string; trajectory?: Trajectory }): SendResult {
  const { runId, operatorId } = args;

  if (!isApproved(runId)) {
    throw new ReviewError(
      `run ${runId} has not been approved by an operator. ` +
        `Approve it first: npm run review -- approve ${runId} --operator <your-id>`,
    );
  }

  const proposal = loadProposal(runId);
  if (proposal.status === "sent") throw new ReviewError(`run ${runId} was already sent`);
  if (proposal.letter === null) throw new ReviewError(`run ${runId} has no letter to send`);

  const mode = process.env.SEND_MODE ?? "simulate";
  const sentAt = new Date().toISOString();

  record({
    runId,
    action: "send",
    operatorId,
    at: sentAt,
    notes: null,
    acceptedViolations: [],
    sendMode: mode,
  });
  args.trajectory?.human("send", operatorId, `mode=${mode}`);
  saveProposal({ ...proposal, status: "sent" });

  if (mode === "simulate") {
    return { simulated: true, runId, sentAt };
  }

  // Live delivery is intentionally not implemented. Wiring a real channel is a
  // deployment decision for the operator, and shipping an untested outbound
  // path behind a config flag is how an unfinished integration reaches a
  // customer.
  throw new ReviewError(
    `SEND_MODE=${mode} but no outbound channel is configured. ` +
      `The approval was recorded; nothing was transmitted.`,
  );
}
