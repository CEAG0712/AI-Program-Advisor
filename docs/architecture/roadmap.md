# Roadmap, evidence and authorization

This is a scope/status record, not a delivery guarantee. Evidence vocabulary is defined in the [overview](overview.md). The owner-supplied P3-D1.1A implementation authorization is the source for historical acceptance/publication and planning allocations; original mission artifacts and the full Day 1 plan are unavailable here.

## Completed foundation

| Milestone | Status and evidence |
| --- | --- |
| Day 0 Missions 1–5 | Architecture discussions completed according to **CONFIRMED — OWNER DAY 0 RECAP**. Original conversational artifacts are absent from the repository; no per-mission dialogue is reconstructed. |
| D1.1 | Nine-file engineering harness accepted and publicly published according to owner authorization. Published baseline: `25b56fff79d865a79911d1daabb29a19e04283c1`. **CONFIRMED — REPOSITORY:** Local HEAD and `origin/main` match that SHA; `main` tracks `origin/main`. No remote fetch or independent server-side publication verification was performed in D1.1A. |

[D1.1 verification](../verification/D1.1.md) records historical harness execution. Its pre-publication status and the [README](../../README.md) remain historical evidence; D1.1A does not rewrite either. Publishing source does not mean deploying an application.

## Current authorized increment

D1.1A authorizes source reconciliation, creation of exactly five architecture Markdown documents, local non-destructive verification and an independent-review handoff. The document set is [overview](overview.md), [system design](system-design.md), [decisions](decisions.md), [security](security.md) and this roadmap.

Documentation is written; local verification results and disposition belong in the execution handoff. Human acceptance remains pending. No application behavior, publication or D1.2 execution is authorized by this increment.

## Planned, not authorized

| Increment | Source-supported scope |
| --- | --- |
| D1.2 | NestJS and real PostgreSQL foundation, tenant-safe initial catalog. Original planning allocation: 70 minutes, subject to actual available time and separate authorization. |
| D1.3 | Deterministic tenant-safe catalog/recommendation baseline within the owner-described Day 1 plan. Exact implementation allocation and Rust integration timing remain unresolved. |
| D1.4 | Integrated local verification, Day 1 review and CHEAT MODE interview defense. Detailed allocation unavailable. |
| Days 2–5 | Remaining Rust, OpenAI, AWS/LocalStack and production-style engineering scope. Exact day-by-day allocation: **TO BE RECOVERED**. This does not assert all target capabilities will fit. |

## Constraints and time accounting

- Day 0 architecture exercise: four hours; Days 1–5 framework: four hours per day.
- Day 1 ceiling: 240 minutes. D1.1A allowance: 20 minutes including inspection, drafting, verification and reporting, within that ceiling.
- Full implementation ceiling: 20 hours. Provisional execution budget: $15. No paid operation without separate approval.
- Cumulative Day 1 elapsed time and remaining time are **UNKNOWN**. Partial historical measurements cannot establish total compliance. Measure each execution window separately and stop if reliable evidence shows a ceiling reached.
- The 70-minute D1.2 allocation is a planning value, not evidence of remaining time or a delivery guarantee. Establish a feasible timebox before further implementation; do not extend ceilings silently.
- Authorization gates are separate: document/application changes, staging/commits, remote pushes, infrastructure and paid operations. D1.1A grants only its five-file documentation scope. Stop after verification for independent review.

## Missing-decision register

All entries below are **UNRESOLVED**; no default is silently selected.

| Decision/evidence gap | Needed for D1.2 or later? |
| --- | --- |
| Minimal REST contracts and request validation | Decide before implementing affected D1.2 endpoints; full API can wait |
| Database schema, monetary representation, migrations and connection strategy | Decide minimal foundation before D1.2 persistence |
| PostgreSQL runtime availability | Verify within separately authorized D1.2 before claiming database readiness |
| Authentication/trusted tenant mechanism and enforcement | Decide before tenant-accessible behavior; preserve boundary during D1.2 design |
| Fixture catalog, prerequisite and unknown-eligibility semantics | Decide before seeding or exposing initial catalog/policy behavior |
| Rust integration, scoring, deterministic ties and candidate bounds | Before ranking implementation; exact Day 1 integration timing not recovered |
| Model, tool contracts, retries, call/token/time/cost budgets and safe fallback | Before model integration or paid calls |
| Provider adapter protocol, freshness and authority reconciliation | Before real-provider integration; can wait for D1.2 |
| Checkout confirmation binding, expiry and concurrency | Before mock handoff; can wait for D1.2 |
| AWS topology, availability, backup/restore, RTO/RPO and secret operations | Before infrastructure/recovery commitments |
| LocalStack Base service coverage and entitlement | Before choosing/running simulation experiments |
| Quantitative SLOs and performance benchmarks | Before making quantitative claims; not required to claim a minimal foundation exists |
| Original mission artifacts and exact Day 2–5 breakdown | Recover before asserting historical detail or detailed scheduling |
| Cumulative Day 1 time and feasible remaining allocation | Resolve as far as evidence permits before further implementation; never claim known compliance while unknown |

The [ADRs](decisions.md) record confirmed directions; [system design](system-design.md) and [security](security.md) label new proposals and remaining implementation gaps. None establishes personal engineering mastery or production readiness.
