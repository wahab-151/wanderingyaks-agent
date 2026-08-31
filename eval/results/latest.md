# Evaluation results

Generated 2026-08-31T06:31:36.937Z

## Headline

Feasibility violations are the primary metric. Grounding violations are
reported separately because the agent avoids them by construction - it can
only compose from the knowledge base - so counting them together would
overstate the difference between the systems.

| Metric | baseline | agent | agent-norepair |
|---|---|---|---|
| **Feasibility violations / itinerary** | **0.67** | **0.00** | **0.00** |
| Grounding violations / itinerary | 23.00 | 0.00 | 0.00 |
| Fidelity violations / itinerary | 0.00 | 0.00 | 0.00 |
| All hard violations / itinerary | 23.67 | 0.00 | 0.00 |
| Sendable without edits | 0/3 | 3/3 | 3/3 |
| Days feasibility-checkable | 94% | 100% | 100% |
| Repair rounds used (total) | 0 | 0 | 0 |
| Cost per itinerary | $0.1453 | $0.0987 | $0.1178 |
| Latency per itinerary | 194s | 118s | 139s |
| Runs that errored | 0 | 0 | 0 |

## Per case

| Case | System | Feas. | Ground. | Fid. | Checkable | Sendable | Cost |
|---|---|---|---|---|---|---|---|
| case-01-april-deosai | baseline | 0 | 29 | 0 | 8/8 | no | $0.1341 |
| case-01-april-deosai | agent | 0 | 0 | 0 | 8/8 | yes | $0.0938 |
| case-01-april-deosai | agent-norepair | 0 | 0 | 0 | 8/8 | yes | $0.1078 |
| case-02-summer-hunza | baseline | 0 | 26 | 0 | 10/10 | no | $0.1503 |
| case-02-summer-hunza | agent | 0 | 0 | 0 | 10/10 | yes | $0.1238 |
| case-02-summer-hunza | agent-norepair | 0 | 0 | 0 | 10/10 | yes | $0.1351 |
| case-03-tight-budget | baseline | 2 | 14 | 0 | 5/6 | no | $0.1516 |
| case-03-tight-budget | agent | 0 | 0 | 0 | 6/6 | yes | $0.0785 |
| case-03-tight-budget | agent-norepair | 0 | 0 | 0 | 6/6 | yes | $0.1105 |

## Notes

- `Checkable` is the number of days whose location resolved against the
  knowledge base. Feasibility checks cannot run on the others, so a low
  number here means the feasibility column is based on little evidence.
- Violation codes withheld from the repair loop are listed in
  `DEFAULT_HELD_OUT` in `src/verify.ts`. They are scored here in full.
