# P3 AI Program Advisor

Architecture documentation for an independent, synthetic portfolio simulation aligned with the original Wandari **Intelligent Agent for E-commerce** assignment. The evidence covers local implementation and controlled acceptance.

## Evidence and provenance

- **CONFIRMED — REPOSITORY:** The original [harness verification](../verification/D1.1.md) covers baseline `25b56fff79d865a79911d1daabb29a19e04283c1`. The [README](../../README.md) and [B3 evidence record](b3-gate-implementation-status.md) describe the subsequent local catalog, recommendations and advisor.
- **CONFIRMED — OWNER DAY 0 RECAP:** The P3-D1.1A authorization records the Maria scenario, catalog assumptions, component responsibilities, infrastructure target and planning constraints. The original Day 0 mission artifacts are unavailable, leaving **INSUFFICIENT EVIDENCE** to reconstruct the dialogue.
- **PROPOSED** and **UNRESOLVED** identify design ideas and open decisions in the historical architecture documents.

## Business context and goals

Maria is a fictional student seeking AI/backend learning offers with approximately $300, basic Python knowledge and six study hours per week. The local acceptance fixture contains six synthetic offers across two fictional academy tenants. The Day 0 plan envisioned roughly 12–20 offers.

The goal is to recommend suitable, authorized catalog offers with understandable explanations and support a valid no-match result. PostgreSQL supplies simulated prices, and backend policy checks exact declared prerequisites. The evidence establishes no customer outcome or latency service-level objective (SLO).

## Business invariants

The primary wording is from [AGENTS.md](../../AGENTS.md):

1. Never invent course offers or authoritative prices.
2. Never accept a model-provided tenant ID as authorization.
3. Never expose cross-tenant catalog data.
4. Never waive prerequisites or silently treat unknown eligibility as valid.
5. Never interpret a model recommendation as checkout authorization.
6. No suitable offer is a valid and safe response.
7. Preserve an explicit future catalog integration boundary.

Caller-provided tenant values likewise confer no authority. Backend policy decides synthetic suitability, and the catalog supplies facts. A future mock checkout handoff would require fresh server-side revalidation of price, eligibility and availability, followed by explicit user confirmation.

## Scope and current status

The NestJS/TypeScript advisor authenticates a structured request and passes server-derived tenant context to the advisor service. The service accepts a single bounded model proposal, validates it against the confirmed constraints, and executes the tenant-scoped PostgreSQL recommendation lookup. The server uses the authorized facts to render either a validated explanation plan or deterministic fallback. A failed catalog read produces a sanitized error. The OpenAI adapter uses explicit server-side composition, and ordinary startup leaves the advisor disabled. [HTTP controller](../../src/ai/advisor.controller.ts) · [Advisor service](../../src/ai/advisor.service.ts) · [OpenAI adapter](../../src/ai/openai.model.client.ts)

| Status | Meaning and evidence |
| --- | --- |
| **Implemented and tested** | Local synthetic catalog, demo bearer authentication, deterministic recommendations, bounded advisor orchestration and the OpenAI Responses API adapter. Verification includes offline mocks, real local PostgreSQL with a fake model and one successful controlled OpenAI and PostgreSQL acceptance. |
| **Verified in LocalStack** | A local Terraform runner created, inspected and removed one VPC and one application subnet in LocalStack Community 4.14.0. Both resource IDs were absent after cleanup and Terraform state was empty. [Diagram](d4-localstack.svg) · [Day 4 record](../verification/D4-localstack.md) |
| **Designed or targeted** | Rust ranking, future provider catalog integration, and Amazon Web Services (AWS) infrastructure including Elastic Compute Cloud (EC2) and Relational Database Service (RDS). The AWS Terraform foundation passed offline validation and a mocked topology test. [Terraform foundation](../verification/D4-R2-infrastructure.md) |
| **Unverified** | Real AWS infrastructure and application deployment, production authentication and authorization, database-enforced tenant isolation, verified admission eligibility and operational SLOs. |

## Reading guide

- [B3 implementation and verification status](b3-gate-implementation-status.md) records the current advisor evidence and limitations.
- [B3B HTTP-to-PostgreSQL sequence](b3b-http-postgresql-sequence.md) and [tenant trust boundaries](b3b-tenant-trust-boundaries.md) describe the earlier fake-model acceptance path.
- [System design](system-design.md), [architecture decision records](decisions.md) and [security design](security.md) document the Day 0 target and the D1.1A checkpoint.
- [Roadmap](roadmap.md) preserves D1.1A planning, time ceilings and historical authorization wording.
