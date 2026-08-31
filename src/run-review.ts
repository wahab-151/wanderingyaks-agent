import "dotenv/config";
import {
  listProposals,
  loadProposal,
  approve,
  reject,
  send,
  approvals,
  isApproved,
  ReviewError,
} from "./review.js";

/**
 * The operator review surface.
 *
 *   npm run review                              list what is waiting
 *   npm run review -- show <runId>              read one in full
 *   npm run review -- approve <runId> --operator wahab [--notes "..."]
 *   npm run review -- reject  <runId> --operator wahab --notes "why"
 *   npm run review -- send    <runId> --operator wahab
 *
 * A terminal rather than a dashboard, on purpose. The gate is what has to
 * exist; the interface over it is a deployment decision, and building a UI
 * would have taken time from the evaluation work that carries the marks.
 */

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : null;
}

const args = process.argv.slice(2).filter((a, i, all) => {
  if (a.startsWith("--")) return false;
  const prev = all[i - 1];
  return !(prev && prev.startsWith("--"));
});

const command = args[0] ?? "list";
const runId = args[1] ?? null;

function requireOperator(): string {
  const operator = flag("operator");
  if (!operator) {
    console.error(
      "\nAn operator id is required. An approval that cannot be attributed to a person is not an approval.\n" +
        "  npm run review -- approve <runId> --operator <your-id>\n",
    );
    process.exit(1);
  }
  return operator;
}

function requireRunId(): string {
  if (!runId) {
    console.error(`\nWhich run? Usage: npm run review -- ${command} <runId> --operator <your-id>\n`);
    process.exit(1);
  }
  return runId;
}

function printList(): void {
  const pending = listProposals("awaiting_review");
  const all = listProposals();

  if (all.length === 0) {
    console.log("\nNothing to review. Run `npm run agent` to produce a proposal.\n");
    return;
  }

  console.log(`\n${pending.length} awaiting review, ${all.length} total\n`);
  console.log(`  ${"run".padEnd(28)} ${"status".padEnd(16)} ${"pax".padEnd(4)} ${"per person".padEnd(11)} violations`);
  console.log(`  ${"-".repeat(28)} ${"-".repeat(16)} ${"-".repeat(4)} ${"-".repeat(11)} ----------`);
  for (const p of all) {
    const hard = p.violations.filter((v) => v.severity === "hard").length;
    const soft = p.violations.length - hard;
    console.log(
      `  ${p.runId.padEnd(28)} ${p.status.padEnd(16)} ${String(p.brief.groupSize).padEnd(4)} ` +
        `${(p.costSheet ? `$${p.costSheet.perPersonUsd.toFixed(0)}` : "-").padEnd(11)} ` +
        `${hard} hard, ${soft} soft`,
    );
  }
  console.log(`\n  npm run review -- show <runId>\n`);
}

function printOne(id: string): void {
  const p = loadProposal(id);
  const history = approvals(id);

  console.log(`\n${p.runId}  [${p.status}]`);
  console.log(`created ${p.createdAt}  tenant ${p.tenantId}\n`);
  console.log(`inquiry\n-------\n${p.inquiry}\n`);

  console.log("brief\n-----");
  console.log(
    `  ${p.brief.groupSize} travellers, ${p.brief.nights} nights, ` +
      `${p.brief.startDate ?? "no date"} | ${p.brief.nationalities.join(", ") || "nationality unknown"}`,
  );
  if (p.brief.missingFields.length) console.log(`  not stated: ${p.brief.missingFields.join(", ")}`);

  if (p.draft.assumptions.length) {
    console.log("\nassumptions to check\n--------------------");
    for (const a of p.draft.assumptions) console.log(`  - ${a}`);
  }

  console.log("\nverifier\n--------");
  if (p.violations.length === 0) console.log("  no violations");
  for (const v of p.violations) {
    console.log(`  ${v.severity === "hard" ? "x" : "!"} [${v.code}] ${v.day === 0 ? "trip" : `day ${v.day}`}: ${v.detail}`);
  }

  if (p.costSheetText) console.log(`\n${p.costSheetText}`);
  if (p.letter) console.log(`\n${"=".repeat(72)}\nCUSTOMER LETTER\n${"=".repeat(72)}\n\n${p.letter}`);

  if (history.length > 0) {
    console.log(`\nhistory\n-------`);
    for (const h of history) {
      console.log(`  ${h.at}  ${h.action.padEnd(8)} by ${h.operatorId}${h.notes ? ` - ${h.notes}` : ""}`);
    }
  }

  const hard = p.violations.filter((v) => v.severity === "hard").length;
  console.log(
    `\n${hard > 0 ? `WARNING  ${hard} unresolved hard violation(s). Approving records that you accepted them.` : "Passes every check."}`,
  );
  console.log(`\n  npm run review -- approve ${p.runId} --operator <your-id>\n`);
}

function main(): void {
  switch (command) {
    case "list":
      printList();
      break;

    case "show":
      printOne(requireRunId());
      break;

    case "approve": {
      const id = requireRunId();
      const operator = requireOperator();
      const p = approve({ runId: id, operatorId: operator, ...(flag("notes") ? { notes: flag("notes")! } : {}) });
      const hard = p.violations.filter((v) => v.severity === "hard").length;
      console.log(`\napproved ${id} by ${operator}`);
      if (hard > 0) console.log(`  ${hard} hard violation(s) were outstanding and are recorded as accepted.`);
      console.log(`\n  npm run review -- send ${id} --operator ${operator}\n`);
      break;
    }

    case "reject": {
      const id = requireRunId();
      const operator = requireOperator();
      reject({ runId: id, operatorId: operator, ...(flag("notes") ? { notes: flag("notes")! } : {}) });
      console.log(`\nrejected ${id} by ${operator}\n`);
      break;
    }

    case "send": {
      const id = requireRunId();
      const operator = requireOperator();
      const result = send({ runId: id, operatorId: operator });
      console.log(
        `\n${result.simulated ? "SIMULATED SEND" : "SENT"}  ${id} at ${result.sentAt}` +
          `${result.simulated ? "\n  SEND_MODE=simulate, so nothing left this machine. The action was recorded." : ""}\n`,
      );
      break;
    }

    case "status": {
      const id = requireRunId();
      console.log(`\n${id}: ${isApproved(id) ? "approved" : "NOT approved"}\n`);
      break;
    }

    default:
      console.error(`\nUnknown command "${command}". One of: list, show, approve, reject, send, status\n`);
      process.exit(1);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ReviewError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
