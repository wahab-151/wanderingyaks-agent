# Knowledge base sources — what is real and what is placeholder

Every file under `kb/` carries a `verified:` or `ratesVerified:` flag. `loadKb()`
collects the ones still set to `false` into `kb.unverifiedFiles`, and a test
asserts the list is non-empty so that placeholder data cannot quietly ship as if
it were the operator's own.

**Current status: nothing has been verified.** Everything below is a placeholder.

| File | Layer | Status | Who can verify it |
|---|---|---|---|
| `regions/gilgit-baltistan/locations.yaml` | region | placeholder | operator, from experience |
| `regions/gilgit-baltistan/routes.yaml` | region | placeholder | operator, from experience |
| `regions/gilgit-baltistan/seasons.yaml` | region | placeholder | operator, from experience |
| `regions/gilgit-baltistan/permits.yaml` | region | placeholder | operator + current government rules |
| `tenants/wanderingyaks/tenant.yaml` | tenant | placeholder | operator |
| `tenants/wanderingyaks/inventory.yaml` | tenant | **placeholder — highest priority** | operator cost sheet |
| `tenants/wanderingyaks/packages.yaml` | tenant | prices from existing catalog | already published |

---

## 1. The cost sheet (blocks `price.ts` being meaningful)

`price.ts` reads `inventory.yaml` and nothing else. Until these are real, the
architecture argument holds — the model is not inventing prices — but the
"price error vs. actual quote" metric cannot be reported honestly.

What is needed, in the operator's own terms:

**Accommodation** — for each property actually used, the *net* rate paid per
room per night, not the public rack rate. Peak and off-peak if they differ.

**Transport** — day rate for each vehicle class (jeep, sedan, Hiace, coaster),
and whether fuel and the driver are inside that rate or billed separately.

**Staff** — day rate for a guide, a porter, a trek cook. Whether a guide is
charged once per group or per vehicle.

**Fixed extras** — the Islamabad–Skardu flight, park entry fees, anything else
billed per person independent of nights.

**Margin** — the percentage actually applied over cost, and whether it varies by
trip length or group size.

If any of these vary by season or group size, say so rather than averaging — the
schema can carry the variation, and an average that hides a peak-season rate
produces a quote the operator loses money on.

## 2. Operating thresholds (`tenant.yaml`)

- **Maximum driving hours in one day.** Currently 6.0. This is the single most
  frequently triggered rule, so a wrong value produces either false violations
  the repair loop chases or real ones it misses.
- **Margin percentage.** Currently 0.18.
- **Acclimatisation limits.** Currently 600 m of sleeping gain per day above
  2500 m. This is a medical guideline rather than a preference; tightening it is
  supported, loosening it is not.

## 3. Region facts

- **Drive times** in `routes.yaml` should be realistic moving time for a loaded
  tour vehicle including normal stops, not best-case mapping-app time.
- **Sleeping elevations** in `locations.yaml`. Only the settlement where clients
  actually sleep matters, not nearby summits.
- **Season windows** in `seasons.yaml`. The month and rough date each road or
  valley opens and closes in a normal year. Approximate is fine and far better
  than absent — this file is most of why the agent beats a generic model.
- **Permits** in `permits.yaml`. Which zones need one, which nationalities it
  applies to, and how much notice. These change; they need rechecking each
  season regardless of what is recorded here.

---

## 4. Evaluation cases (blocks the Measured Improvement section)

The source is WhatsApp inquiry threads and the itinerary PDF that was sent back.
Target is 12–15 matched pairs, including at least one where the operator had to
talk the customer out of what they asked for.

**Nothing from a real customer conversation may enter this repository
unanonymised.** Hackathon ground rule 07, and it is the right call anyway.

For each case, what is needed is:

1. **The inquiry text**, with every personal detail removed: name → `Customer A`,
   no phone number, no email, no employer, no travel-document number. Nationality
   is kept, because it drives permit rules and is not identifying on its own.
2. **The itinerary that was actually sent** — day, place, hotel, and the quoted
   total. The prose does not need to be preserved; the structure does.
3. **Roughly how long it took to build.** An honest recollection is fine and is
   the business headline number. Nobody was recording it at the time, so an
   estimate labelled as an estimate is more credible than a fabricated precision.

### How to do it

```bash
npm run ingest -- --from path/to/whatsapp-exports/ --operator "Wandering Yaks"
```

Export the threads from WhatsApp (Chat -> Export chat -> Without media) into a
folder and point the tool at it. For each thread it produces a draft case in
`eval/cases-staging/`, which is gitignored.

What it does:

- Parses both WhatsApp export formats, joins multi-line messages, drops the
  app's own system lines and `<Media omitted>` placeholders.
- **Drops your replies.** `--operator` names your side of the thread. Your reply
  contains the itinerary the agent is supposed to work out for itself, so
  including it would score the agent on an enquiry that already holds the answer.
- Redacts phone numbers, emails, URLs, social handles, CNICs, passport numbers,
  and participant names (replaced with a stable `Customer A` so the thread still
  reads as a conversation).
- **Keeps** destinations, dates, party size, budget and nationality. Those are
  what the brief is made of, and nationality drives permit rules.
- **Flags but does not delete** capitalised words that might be people. Deleting
  a place name silently breaks the case, so that call is yours, not a regular
  expression's.

Each draft carries a `_review` block listing what was redacted and what was only
suspected. **`loadCases()` refuses any file that still has that block**, so a
draft cannot reach the evaluation without someone having read it and deleted it
deliberately.

Then: read every draft line by line, fill in `today`, the brief and
`groundTruth` from what you actually sent, delete `_review`, move the file into
`eval/cases/`, and run `npm test`.

Automated scrubbing alone is not a defensible standard for someone else's
personal data in a repository judges will read. The tool does the mechanical
part; the judgement stays with the person who ran the trip.
