# Reproduction guide

Written for someone starting from an empty machine who has never seen this
project. Everything below has been run on a clean clone.

## What you need

| | |
|---|---|
| Node | 20 or later (developed on 22.15.0) |
| npm | 10 or later (developed on 10.9.2) |
| OS | Developed on Windows 11. No platform-specific code; paths go through `node:path`. |
| API key | An OpenAI key with access to `gpt-5`. Nothing else. |
| Disk | ~120 MB, almost all `node_modules` |

There is no database to install, no Docker, no native compilation. Storage is
YAML and JSON on disk, deliberately - a native dependency is a reproducibility
tax and this project does not need one.

## Setup

```bash
git clone <repo>
cd wanderingyaks-agent
npm install
cp .env.example .env
```

Then open `.env` and set one value:

```
OPENAI_API_KEY=sk-...
```

The other three have working defaults and only need changing if you want
something different:

| Variable | Default | What it does |
|---|---|---|
| `TENANT_ID` | `wanderingyaks` | Which directory under `kb/tenants/` to load |
| `MODEL` | `gpt-5` | Model for every LLM stage |
| `SEND_MODE` | `simulate` | **Nothing is transmitted.** See "Nothing gets sent" below |

## Check it works without spending anything

Two commands need no API key and no network:

```bash
npm test        # 106 assertions across schema, KB, verifier, scorer, gate, router
npm run kb:check
```

`npm run kb:check` prints what the knowledge base believes: a month-by-month
season grid, the operating policy, and three worked itineraries run through the
real verifier. Expect the April Deosai itinerary to be **BLOCKED** on three
violations and the rerouted version to be **SENDABLE**.

It also ends by listing five files still carrying placeholder data. That is
correct and expected - see "Honest limits" below.

## The headline result

```bash
npm run eval
```

Runs three synthetic cases through three systems - `baseline`, `agent`,
`agent-norepair` - and writes `eval/results/latest.md` and `latest.json`.

**Expect roughly:**

| Metric | baseline | agent | agent-norepair |
|---|---|---|---|
| Feasibility violations / itinerary | 0.67 | 0.00 | 0.00 |
| Grounding violations / itinerary | 23.00 | 0.00 | 0.00 |
| Sendable without edits | 0/3 | 3/3 | 3/3 |
| Repair rounds used | – | 0 | 0 |
| Cost per itinerary | $0.1453 | $0.0987 | $0.1178 |

**Runtime:** about 25 minutes for all nine runs. Most of it is the model
reasoning; roughly 75% of output tokens are reasoning tokens.

**Cost:** about **$1.10** for the full sweep at `gpt-5` prices.

**Expect variation.** Reasoning models do not accept a temperature, so runs are
not deterministic. Violation counts have been stable across runs - they are
integers and far apart - but cost and latency move by up to 20%. `agent` and
`agent-norepair` ran identical code paths in our run and still differed by
$0.019 and 21 seconds; that gap is the variance estimate.

Narrower runs:

```bash
npm run eval -- --system baseline
npm run eval -- --case case-01-april-deosai
npm run eval -- --system agent,baseline --case case-01-april-deosai
```

## A single itinerary, end to end

```bash
npm run agent
```

Runs the default enquiry - four friends, eight days in Skardu, late April, $900
each, asking for Deosai. Prints the routing decision, the brief intake
extracted, the day-by-day plan, the verifier result, the internal cost sheet and
the customer letter.

**Expect:** Deosai substituted for Khaplu and Kharmang, with the substitution
explained in the first paragraph of the letter. Zero violations. Around
**$0.13** and **145 seconds**.

Your own enquiry:

```bash
npm run agent -- "6 of us want Hunza for 10 days in July, about \$1500 each, we are Canadian"
npm run agent -- --today 2026-04-01     # pin the date permit checks run against
npm run agent -- --repair 0             # disable the repair loop
```

Pin `--today` if you want a repeatable answer; permit lead-time checks measure
from the current date otherwise.

## Nothing gets sent

`SEND_MODE=simulate` is the default, and the gate does not depend on it.

```bash
npm run review                                          # what is waiting
npm run review -- show <runId>                          # read one in full
npm run review -- approve <runId> --operator your-name
npm run review -- send <runId> --operator your-name     # simulated
```

Three properties, each covered by a test in `src/review.test.ts`:

- **`send` refuses without a recorded approval**, and setting `SEND_MODE=live`
  does not change that. There is no override parameter.
- **Approval and sending are separate operations** writing separate records, so
  a bug in one cannot manufacture the other.
- **Approving something the verifier still objects to records those objections**
  against the operator's name. Overruling the checker is allowed; doing it
  invisibly is not.

With `SEND_MODE=live` the send path records the approval and then refuses,
because no outbound channel is configured. Wiring one is a deployment decision;
shipping an untested outbound path behind a config flag is how an unfinished
integration reaches a customer.

## Where things land

| Path | What |
|---|---|
| `eval/results/latest.md` | The comparison table. Committed. |
| `eval/results/latest.json` | Same data, machine-readable. Committed. |
| `trajectories/*.jsonl` | One file per run. Gitignored. |
| `trajectories/samples/` | Six representative runs. Committed. |
| `data/proposals/*.json` | Proposals awaiting review. Gitignored. |
| `data/approvals.jsonl` | Append-only record of human decisions. Gitignored. |

## Reading a trajectory

One JSON object per line, in order. `run_start`, then the full text of each
system prompt once, then every model call with tokens, cost and latency, every
failed attempt, every deterministic step, any human decision, then `run_end`.

```bash
cat trajectories/samples/agent-case-01-april-deosai.jsonl \
  | node -e "require('readline').createInterface({input:process.stdin}).on('line',l=>{const e=JSON.parse(l);console.log(e.kind.padEnd(10),e.stage||e.outcome||'',e.summary||'')})"
```

Deterministic stages log too, not just model calls. The verifier rejecting a
draft and the repair loop responding is the most interesting thing this system
does and involves no model call at all - a log of only LLM calls would omit the
story.

## Honest limits

**The knowledge base is placeholder data.** No real cost data was available, so
every price is arithmetic over invented rates. `npm run kb:check` lists the
unverified files on every run and a test asserts that list is non-empty, so
placeholders cannot ship pretending to be real. `docs/KB-SOURCES.md` enumerates
exactly what is needed.

**Evaluation cases are synthetic.** Three of them, all marked
`"provenance": "synthetic"`, written to exercise the pipeline rather than drawn
from real customers. Real inquiry/itinerary pairs exist in WhatsApp threads and
sent PDFs but have not been extracted and anonymised. Until they are, price
accuracy against a real quote and minutes saved against a real operator cannot
be reported - and `npm run eval` prints that warning itself rather than leaving
you to notice.

**Three cases is a small sample.** Treat the direction as established and the
magnitudes as provisional.

## If something goes wrong

| Symptom | Cause |
|---|---|
| `No OpenAI credentials found` | `.env` missing or `OPENAI_API_KEY` unset |
| `OpenAI rejected the ... request` naming a schema keyword | Strict mode rejected a JSON Schema keyword. Add it to `STRIPPED` in `src/json-schema.ts`. |
| `response was cut off (max_output_tokens)` | Reasoning consumed the budget. Raise `maxTokens` at the call site. |
| `knowledge base failed referential integrity` | A `kb/` edit left a dangling id. The message names it. |
| `missing knowledge base file` | `TENANT_ID` points at a directory that does not exist |
| Model not found | Your key has no `gpt-5` access. Set `MODEL=gpt-4.1` in `.env`. |
