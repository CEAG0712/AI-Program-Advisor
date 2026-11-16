# P3 AI Program Advisor

Architecture documentation for an independent Wandari-aligned portfolio simulation of the original **Intelligent Agent for E-commerce** assignment. This is not evidence of Wandari employment, customer engagement, production operation or commercial outcomes.

## Evidence and provenance

- **CONFIRMED — REPOSITORY:** [Operating contract](../../AGENTS.md), [current implementation](../../README.md), [harness manifest](../../package.json), [configuration template](../../.env.example) and [D1.1 verification](../verification/D1.1.md) were inspected at baseline `25b56fff79d865a79911d1daabb29a19e04283c1`.
- **CONFIRMED — OWNER DAY 0 RECAP:** The owner-supplied P3-D1.1A implementation authorization supplies the Maria scenario, catalog assumptions, component responsibilities, infrastructure target and planning constraints. Original Day 0 Missions 1–5 were conversational exercises; their original artifacts are unavailable here. This increment formalizes recoverable decisions, not reconstructed dialogue.
- **PROPOSED:** New implementation analysis is explicitly labeled. **UNRESOLVED:** No final decision is supported. Neither label establishes accepted historical behavior.

## Business context and goals

Maria is a fictional student seeking AI/backend learning offers with approximately $300, basic Python knowledge and six study hours per week. The planned synthetic catalog contains roughly 12–20 course offers across two fictional academy tenants. No real academy inventory or prices are asserted.

The qualitative goal is to recommend suitable, authorized catalog offers with understandable explanations, preserve prerequisite uncertainty and accept that no suitable offer may exist. PostgreSQL will supply authoritative simulated prices; the model cannot invent them. No business KPI, latency SLO or customer outcome is established.

## Business invariants

The primary wording is from [AGENTS.md](../../AGENTS.md):

1. Never invent course offers or authoritative prices.
2. Never accept a model-provided tenant ID as authorization.
3. Never expose cross-tenant catalog data.
4. Never waive prerequisites or silently treat unknown eligibility as valid.
5. Never interpret a model recommendation as checkout authorization.
6. No suitable offer is a valid and safe response.
7. Preserve an explicit future catalog integration boundary.

Caller-provided tenant values likewise confer no authority. Recommendation is advisory guidance; eligibility is a backend policy decision; catalog authority supplies facts. A future mock checkout handoff is a separate action requiring fresh server-side revalidation of price, eligibility and availability, followed by explicit user confirmation. Checkout is not implemented.

## Scope and current status

The target includes NestJS/TypeScript, PostgreSQL, Rust ranking, bounded OpenAI tool use, AWS EC2/RDS infrastructure, Terraform and bounded LocalStack experimentation. Real payments, automatic purchasing, customer deployment claims and invented inventory are outside this simulation's scope.

| Status | Meaning and evidence |
| --- | --- |
| Designed | Target directions from repository and owner recap; not proof of execution |
| Implemented | D1.1 nine-file engineering harness; D1.1A adds documentation only |
| Tested | Historical harness checks recorded in D1.1 evidence; application controls are untested |
| Emulated | No P3 AWS services emulated |
| Deployed | No P3 application or infrastructure deployed; publishing harness source is distinct |

The manifest has development dependencies only. TypeScript checks the environment inspection script. There are no application endpoints, authentication, catalog database, eligibility enforcement, ranker or model calls. Historical environment observations do not establish current PostgreSQL readiness.

## Reading guide

- [System design](system-design.md): components, trust boundaries and target diagram.
- [Decisions](decisions.md): nine ADRs and their unresolved details.
- [Security](security.md): required controls, safe failures and untested recovery directions.
- [Roadmap](roadmap.md): milestone evidence, time ceilings and authorization gates.
