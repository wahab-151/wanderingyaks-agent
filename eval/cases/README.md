# Evaluation cases

Every case in this directory is marked `"provenance": "synthetic"`. They were
written to exercise the pipeline, not drawn from real customer conversations,
and no real person's inquiry, name, contact details or trip appears here.

`groundTruth` is null throughout because the real matched pairs - a customer
inquiry alongside the itinerary the operator actually sent and the time it took
to build - have not been extracted and anonymised yet. Until they are, the
evaluation can report feasibility, grounding and cost, but not price accuracy
against a real quote or minutes saved against a real baseline.

See `../../docs/KB-SOURCES.md` section 4 for what those cases need to contain
and how they must be scrubbed before they can be committed here.

`brief` is pinned on each case rather than parsed from `inquiry`, because the
intake stage does not exist yet. When it does, the pinned brief becomes the
expected output for testing intake, and the pipeline reads from `inquiry`.

`today` is pinned so that permit lead-time checks give the same answer whenever
the evaluation is re-run.
