# Custom itinerary agent for tour operators

A tour operator receives a message: *"4 friends, 8 days in Skardu, late April,
around $900 each, we'd love to see Deosai."* Nothing in the published catalogue
matches it. Someone now has to build the trip by hand.

This system does that build, grounds it in the operator's own inventory, checks
it against physical and legal constraints in deterministic code, prices it
without a model anywhere near the arithmetic, and hands the result to a human to
approve.

---

## Who has the problem

Tour operators running trips in Gilgit-Baltistan - Skardu, Hunza, Khaplu,
Fairy Meadows, Deosai. The first tenant is [Wandering Yaks](https://wanderingyaks.com);
the engine is built so a second operator is a new directory, not a rewrite.

## The bottleneck

Two failures in the same workflow:

**Custom builds eat the hours that should go to selling.** An enquiry that does
not match a published package has to be assembled by hand - cross-checking which
valleys are open on those dates, which hotels the operator actually holds
contracts with, whether the drive days are survivable, whether the group's
nationalities need a permit and whether there is time to get one. Response
latency loses bookings, and the operator's scarce hours go into assembly.

**The same enquiry gets two different answers.** Handled by two people, it
produces two itineraries at two prices, because the constraints live in
individual heads rather than anywhere checkable.

## Why a general-purpose model does not solve it

We measured this rather than asserting it, and the result was not what we
expected. A frontier model writes a *good* itinerary - real drive times,
sensible pacing, under budget. On the April Deosai case it knew unprompted that
the plains would still be under snow.

What it cannot do is use inventory it has never seen. It writes a good trip for
a different company.

| 3 synthetic cases | baseline | this system |
|---|---|---|
| Feasibility violations / itinerary | 0.67 | **0.00** |
| Grounding violations / itinerary | 23.00 | **0.00** |
| Sendable without operator edits | 0/3 | **3/3** |
| Cost per itinerary | $0.1453 | **$0.0987** |
| Latency per itinerary | 194s | **118s** |

The grounding column is the finding: 23 violations per itinerary means hotels
the operator holds no contract with, roads that do not connect, and places that
are not on the books. Both systems were given the same enquiries and scored by
the same verifier.

The cost column was a surprise. Constraining the model to real inventory made it
*cheaper*, not dearer - there is less to work out when the options are already
narrowed.

Full comparison and how it got there: [docs/CHANGELOG.md](docs/CHANGELOG.md).
Raw output: [eval/results/](eval/results/).

---

## The load-bearing principle

**Modules that call the model never decide anything that must be correct.
Modules that must be correct never call the model.**

| Calls the model | Never calls the model |
|---|---|
| `intake` - messy text to a structured brief | `retrieve` - which inventory is usable |
| `compose` - brief plus inventory to a draft | `verify` - feasibility rules |
| `repair` - draft plus violations to a fix | `price` - arithmetic |
| `render` - draft plus costs to prose | `kb` - typed data access |

Pricing in particular is never done by a model. A wrong quote is worse than no
quote: it is the one output that binds the operator commercially, and a system
that is right 95% of the time is not good enough when the 5% is money.

## Pipeline

```
inquiry
  -> intake      LLM   -> Brief
  -> router      code  -> does the catalogue already answer this?
  -> retrieve    code  -> only the inventory that is actually usable
  -> compose     LLM   -> DraftItinerary
  -> verify      code  -> Violation[]
     <-> repair  LLM      capped, every attempt logged
  -> price       code  -> CostSheet
  -> render      LLM   -> customer letter + internal cost sheet
  -> operator review    HARD GATE
  -> send               simulated by default
```

`retrieve` is doing more work than it looks. Rather than describing the whole
catalogue and trusting the model to filter it, compose is handed only what it is
allowed to use - properties this operator holds, in places open on the requested
dates, with vehicles that seat the group. **A hotel that is not in that payload
cannot be booked, because the composer never sees it.**

## Design choices worth defending

**The knowledge base is split into region and tenant layers.** When Deosai opens
is a fact about Pakistan; which hotel you have a contract with is a fact about
your company. `kb/regions/` holds the first, `kb/tenants/` the second.

This is demonstrated rather than asserted. `kb/tenants/highpass-demo/` is a
fictional second operator working the same valleys:

```bash
npm run kb:check highpass-demo
npm run agent -- --tenant highpass-demo
```

It shares all 32 locations, all 43 road segments, the same season windows and
the same permit rules - because those are facts about Pakistan, not about either
company. It brings its own 16 properties, its own rates, its own catalogue, and
a 9-hour daily driving limit against the first tenant's 6. `src/multi-tenant.test.ts`
asserts both halves: that the region layer is identical and that neither
operator can book the other's rooms. A 7-hour drive is a violation for one and
acceptable for the other, from the same road in the same knowledge base.

Adding it required no code change.

**Some verifier rules are withheld from the repair loop.** `verify()` is both
the repair loop's oracle and the evaluation's scorer, so "the agent loops until
verify is clean, and verify says it is clean" would be circular.
`DEFAULT_HELD_OUT` in `src/verify.ts` keeps `ALTITUDE_GAIN` and
`PERMIT_MISSING` out of the repair prompt, giving an honest signal: violations
the agent avoided without ever being told about them. They still reach the
operator, so nothing unsafe is hidden.

**Violations are reported in families, not as one number.** Three codes are won
by the agent automatically - it cannot invent a hotel it was never shown - so
counting them alongside the rest would overstate the result. Feasibility is the
headline. See iteration 2 in the changelog.

**No agent framework.** Judges score whether design choices were purposeful; a
framework obscures what the agent did and makes trajectories harder to read.

## The hot take

We built the verify/repair loop the spec called for. Across every evaluation
case, **it never fired.**

Compose cannot route through Deosai in April because `retrieve` marked Deosai
closed and never put it on the menu. The correction happens before generation
rather than after it, and the loop is left with nothing to do.

The generalisation: **a verification loop doing a lot of work is evidence that
the retrieval step is handing the model options it should never have had.**
Constraining the input is cheaper than correcting the output - and on this
project it was measurably cheaper, since the constrained pipeline also cost less
per itinerary than the unconstrained baseline.

The loop is still there and still on by default. Three synthetic cases is not
enough to retire a safety net, and the condition for removing it is written down
in the changelog rather than left to judgement.

---

## Running it

Requires Node 20+ and an OpenAI API key.

```bash
npm install
cp .env.example .env          # add OPENAI_API_KEY
npm run kb:check              # no key needed - reads the knowledge base
npm test                      # no key needed - 121 assertions
npm run agent                 # one inquiry, end to end
npm run eval                  # baseline vs agent, writes eval/results/
npm run review                # what is waiting for an operator
npm run eval:intake           # how accurately intake reads an enquiry
npm run ingest -- --from <folder> --operator "Your Company"
```

Useful flags:

```bash
npm run agent -- "6 of us, Hunza, 10 days in July" --today 2026-04-01
npm run agent -- --repair 0                 # disable the repair loop
npm run eval -- --system baseline           # one system
npm run eval -- --case case-01-april-deosai # one case
```

### The human gate

```bash
npm run review                                          # what is waiting
npm run review -- show <runId>                          # read one in full
npm run review -- approve <runId> --operator your-name
npm run review -- send <runId> --operator your-name     # simulated
```

`send` refuses without a recorded approval, and `SEND_MODE=live` does not change
that - there is no override parameter. Approval and sending write separate
records, so a bug in one cannot manufacture the other. Approving something the
verifier still objects to records those objections against the operator's name:
overruling the checker is allowed, doing it invisibly is not.

Full setup, versions, runtime and cost: [docs/REPRODUCTION.md](docs/REPRODUCTION.md).

---

## Honest status

**The knowledge base is placeholder data.** No real rates were available, so
every price is arithmetic over invented numbers. `npm run kb:check` prints which
files are unverified on every run, and a test asserts the list is non-empty so
placeholders cannot ship pretending to be real. What is needed is enumerated in
[docs/KB-SOURCES.md](docs/KB-SOURCES.md).

**Evaluation cases are synthetic.** Eleven of them, all marked
`"provenance": "synthetic"`, covering winter closures, permit traps, altitude
traps, a family with children, a 14-person group, a near-empty enquiry and a
partially-closed route. Real inquiry/itinerary pairs exist in WhatsApp threads
and sent PDFs but have not been extracted and anonymised. Until they are, price
accuracy against a real quote and minutes saved against a real operator cannot
be reported, and the harness prints that warning itself.

**Runs are not deterministic.** Reasoning models do not accept a temperature, so
repeated runs vary. Differences smaller than that variance are not results.

## What pre-existed

Per ground rule 02: everything in this directory was written for this
competition. Two sibling repositories - `wanderingyaks-backend` (Express/Prisma
booking backend) and `wanderingyaks.com` (Next.js site) - pre-date it and are
**not** part of the submission. Nothing here imports from them. Real trip
content in `../TripDetails.md` pre-dates the competition and was used as a style
reference for the `render` prompt.

## Deliverables

| | |
|---|---|
| Improvement changelog | [docs/CHANGELOG.md](docs/CHANGELOG.md) |
| Reproduction guide | [docs/REPRODUCTION.md](docs/REPRODUCTION.md) |
| Agent trajectories | `trajectories/*.jsonl`, one per run |
| Evaluation evidence | [eval/results/](eval/results/) |
