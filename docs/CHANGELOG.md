# Improvement changelog

How this system got from a single prompt to its current shape, and what each
change was worth. Entries are written when the change is made, not
reconstructed afterwards, and experiments that were removed stay in the record
with what they taught us.

Every number here comes from `npm run eval`, and the raw output is committed
under `eval/results/`.

## Measurement caveats, stated up front

Three limits apply to every figure below, and none of them are resolved yet:

1. **Cases are synthetic.** Eleven of them as of iteration 8, up from three.
   Real inquiry/itinerary pairs from WhatsApp exist but have not been extracted
   and anonymised, so nothing here is measured against what an operator actually
   sent. Figures in iterations 1-7 were taken on the original three cases and
   are labelled as such.
2. **Rates are placeholders.** No real cost data was available, so every price
   is arithmetic over invented numbers. Price accuracy is unreportable.
3. **Runs are not deterministic.** Reasoning models do not accept a temperature,
   so repeated runs vary. Treat cost and latency differences under roughly 20%
   as noise; see the variance section at the end for how that was estimated.

---

## Baseline

**What it is.** One model call, no knowledge base, no verifier, no repair. The
prompt is a competent brief - it asks for named hotels, real drive times and
honest pricing - because a strawman baseline would make the comparison
worthless. `baseline/one-shot.ts`, 34 lines.

**Result** (3 synthetic cases, `eval/results/`):

| | |
|---|---|
| Feasibility violations / itinerary | 0.67 |
| Grounding violations / itinerary | 21.33 |
| Sendable without edits | 0/3 |
| Days feasibility-checkable | 73% |
| Cost / itinerary | $0.1367 |

**What it established.** The itineraries are *good prose*. Real properties, real
drive times, sensible pacing, under budget. On the April Deosai case the model
knew unprompted that the plains would be snowbound and wrote in a fallback.

What it cannot do is use the operator's inventory, because it has never seen it.

---

## Iteration 1 - Knowledge base split into region and tenant layers

**Why.** The original spec put everything in a flat `kb/`. But when the owner
confirmed the product is meant for other operators too, that shape broke: when
Deosai opens is a fact about Pakistan, not about this company, and a second
operator in the same valleys should not have to re-enter it.

**What changed.** `kb/regions/<region>/` holds geography and government rules -
locations, roads, seasons, permits. `kb/tenants/<operator>/` holds inventory,
rates and policy thresholds. A new operator is a directory, not a code change.

**Evidence.** No eval delta; this is structural. The claim it supports is
portability, and the test of that claim is pointing the engine at a second
tenant directory - not yet done.

**Kept.**

---

## Iteration 2 - Violations reported in families instead of one number

**Why.** The first eval reported a single "violations per itinerary" figure.
Baseline scored 22. The agent would score near zero. That looked like a decisive
win and it was not an honest one.

Three codes - `NO_INVENTORY`, `UNKNOWN_LOCATION`, `UNKNOWN_SEGMENT` - are won by
the agent *by construction*. It composes from the knowledge base, so it cannot
name a hotel that is not in it. Meanwhile the baseline is penalised for naming
real places the knowledge base happens to lack. A combined figure measures "did
the system read the KB", which is nearly tautological, and buries the question
that matters: given real inventory, does the trip actually work?

**What changed.** `eval/score.ts` splits violations into **grounding**,
**feasibility**, **fidelity** and **advisory**, and the report leads with
feasibility.

**Evidence.** Splitting the baseline's 22.00 combined figure:

| family | per itinerary |
|---|---|
| grounding | 21.33 |
| feasibility | **0.67** |
| fidelity | 0.00 |

**What it taught us.** The project's pitch was wrong. BUILD_SPEC claims a
generic model "will route through roads that are snowbound, schedule impossible
drive days, skip acclimatisation". Measured, it mostly does not - two drive-hour
violations across three cases, zero closures, zero altitude failures. The real
failure is that it writes a good trip *for a different company*. Still a genuine
bottleneck, but a different claim, and now an evidenced one.

**Kept.** This is the most important change in the project so far.

---

## Iteration 3 - The verifier stopped abandoning a day it could not place

**Why.** `verify()` skipped every remaining check on a day whose location it did
not recognise. That meant grounding failures masked feasibility failures: an
itinerary routing through a snowbound valley under an unrecognised name scored
one grounding error and was never season-checked at all.

**What changed.** An unknown location now suppresses only the checks that
genuinely need to know where the day is spent - closure, altitude, permits.
Hotels and road segments are still checked, since those are independent facts.

**Evidence.** Two `DRIVE_HOURS` violations in case-03 became visible that the
previous behaviour had hidden. `eval/score.ts` also began reporting
*scoreability* - how many days could be feasibility-checked at all - so a thin
result is visible rather than flattering.

**Kept.**

---

## Iteration 4 - Knowledge base expanded from what the baseline named

**Why.** The baseline kept naming real Baltistan destinations the knowledge base
did not contain: Hushe, Borith, Minapin, Sadpara, Basho, Manthokha, Kharmang.
Minapin is the Rakaposhi trailhead. Their absence inflated grounding violations
and suppressed feasibility ones, so the KB gap was distorting the measurement in
both directions.

**What changed.** 21 -> 32 locations, 27 -> 43 road segments, 16 -> 26 hotels,
with seasons for each. All still marked `verified: false` pending operator
sign-off.

**What it taught us.** The baseline is a useful instrument in its own right. Run
against a knowledge base, it enumerates what the knowledge base is missing.

**Kept.**

---

## Iteration 5 - Repair loop: does it earn its place?

**Why.** BUILD_SPEC treats `verify <-> repair` as the centrepiece. The first full
pipeline run, deliberately made with `--repair 0`, produced **zero violations
from compose directly** - the loop had nothing to do.

The hypothesis this raises: the work is being done upstream by `retrieve`, which
filters closed locations out before compose ever sees them. Compose cannot route
through Deosai in April because Deosai was never on the menu. If that holds, the
repair loop is dead weight and belongs in this changelog as a removal.

**What changed.** `agent` and `agent-norepair` are separate systems in the eval,
identical but for `maxRepairAttempts` (3 vs 0).

**Evidence** (3 cases, `eval/results/latest.md`):

| Metric | baseline | agent | agent-norepair |
|---|---|---|---|
| **Feasibility violations / itinerary** | **0.67** | **0.00** | **0.00** |
| Grounding violations / itinerary | 23.00 | 0.00 | 0.00 |
| Sendable without edits | 0/3 | 3/3 | 3/3 |
| **Repair rounds used (total)** | - | **0** | **0** |
| Cost per itinerary | $0.1453 | $0.0987 | $0.1178 |
| Latency per itinerary | 194s | 118s | 139s |

**The repair loop never fired.** Not once, across three cases. `agent` and
`agent-norepair` produced identical scores because they ran identical code paths:
compose emitted zero hard violations every time, so the loop had nothing to
correct.

**Decision: kept, defaulted on, and reported as not having fired.**

Removing it would make a tidier story and we are not going to tell it. Three
synthetic cases is a small sample, the loop costs nothing on runs where it does
not fire, and deleting a safety net because it has not yet been needed is how
systems fail later. The condition for removal is explicit: if it still has not
fired across 12+ real anonymised cases, it goes.

**What it taught us - and this is the hot take.**

The value did not come from the loop. It came from `retrieve`.

Compose cannot route through Deosai in April because `retrieve` marked Deosai
CLOSED and never put it on the menu. The correction happens before generation,
not after it. On this evidence, **a verification loop is often compensating for
a retrieval failure - constrain what the model can see and the loop has nothing
left to do.**

The generalisation for building agents: when a verify/repair cycle is doing a
lot of work, that is evidence the retrieval step is handing the model options it
should never have had. Fixing the input is cheaper than correcting the output,
and it is the difference between a system that is right and one that is
repeatedly corrected until it stops being wrong.

**A second finding, unplanned:** the agent is *cheaper and faster* than the
baseline - $0.0987 against $0.1453, 118s against 194s. A constrained model
reasons less because there is less to work out. We expected grounding to cost
extra and it paid for itself.

---

## Iteration 6 - Router, and the human gate

**Why a router.** If an operator already sells a ten-day Hunza tour and someone
asks for a ten-day Hunza tour, they should be offered the trip that has been run
before - known suppliers, known price, a page on the website - not a bespoke one
the agent invented that happens to look similar. The point is consistency, not
cost saving.

**What changed.** `src/router.ts` scores every published package against the
brief on nights, locations, month, fitness and budget, and recommends only above
a deliberately high threshold of 0.75. A near miss dressed as a match is worse
than composing, because the customer receives something that does not answer
what they asked.

**Evidence.** On the default April Skardu enquiry the router fired:

```
recommend: "Skardu and Baltistan" scores 0.79 against a 0.75 threshold
```

**Kept - and note the contrast with iteration 5.** Two components were built on
the spec's say-so. The repair loop never fired once; the router fired on the
first enquiry it saw. Building both and measuring both is what separated them.
Neither was obvious in advance, and the spec was equally confident about each.

**Caveat.** The weights and the 0.75 threshold were set by judgement, not
measurement, because no real enquiry/package pairs exist to tune against. Tuning
them is a changelog entry waiting to be written once real cases arrive.

**The human gate** (`src/review.ts`) landed alongside it, satisfying ground rules
04 and 05. Three properties, each with a test:

- `send` refuses without a recorded approval, and `SEND_MODE=live` does not
  change that. There is no override parameter in the signature.
- Approval and sending write separate records, so a bug in one cannot
  manufacture the other.
- Approving something the verifier still objects to records those objections
  against the operator's name. Overruling the checker is allowed; doing it
  invisibly is not.

Verified end to end: an unapproved send refuses, an unapproved send under
`SEND_MODE=live` refuses, an approval without an operator id refuses, and a
second send of the same proposal refuses.

---

## Iteration 7 - Portability demonstrated instead of asserted

**Why.** The README claimed a second operator was a directory rather than a
rewrite. Nothing in the repository showed that, which ground rule 09 does not
allow: a claim without evidence attached is not a claim.

**What changed.** `kb/tenants/highpass-demo/` is a fictional trekking operator
in the same valleys - its own properties, rates, catalogue and a 9-hour daily
driving limit against the first tenant's 6. `src/multi-tenant.test.ts` asserts
the layering holds in both directions.

**Evidence.** 15 assertions covering: both tenants see identical locations,
roads, seasons and permit rules; neither can book the other's properties; the
same 7-hour drive is a violation for one and acceptable for the other; the same
trip prices differently; the router scores against whichever catalogue is
loaded. Adding the tenant required no code change.

**Kept.**

---

## Iteration 8 - Eleven evaluation cases

**Why.** The brief asks for ten or more cases where the task allows, and there
were three. Three cases makes a direction visible but not a magnitude, and the
three that existed were all fairly benign.

**What changed.** Eight cases added, chosen to probe things the original three
did not: a February enquiry when the high country is shut, a permit request with
four days notice from nationals who need thirty, Rush Lake at 4694m in six days,
a family with a six-year-old, fourteen travellers against a vehicle fleet that
seats twelve, an enquiry that says almost nothing, and a route where one leg is
open and the other is not.

Several are deliberately unanswerable as asked. The correct output is a refusal
with a reason, not a plausible itinerary.

**Evidence.** _Full sweep across 11 cases and 3 systems running; results will
land in `eval/results/`._

---

## Variance

`agent` and `agent-norepair` ran identical code paths and still differed by
$0.019 per itinerary and 21 seconds. That gap is pure run-to-run variance in
reasoning tokens, and it is the best variance estimate currently available.

Treat cost and latency differences below roughly 20% as noise. The violation
counts are integers and far apart (23.67 vs 0.00), so they are not at risk from
this, but a future iteration claiming a small cost win needs repeated runs
before the claim holds.

---

## Removed experiments

**None yet, and the one candidate was deliberately not removed.** See iteration
5: the repair loop never fired, which is exactly the evidence that would justify
deleting it, but three synthetic cases is not enough to retire a safety net. The
removal condition is written down rather than left to judgement.
