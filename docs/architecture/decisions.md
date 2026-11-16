# Architecture decision records

These records formalize recoverable directions, not original meeting notes. Evidence vocabulary is defined in the [overview](overview.md). Rationale, trade-offs and consequences are present-day engineering analysis of confirmed directions, not claims about historical alternative evaluations. No selected choice is thereby tested.

## ADR-001 — Independent synthetic portfolio scope

- **Status/evidence:** Confirmed design direction — **CONFIRMED — REPOSITORY** ([identity](../../README.md)); **CONFIRMED — OWNER DAY 0 RECAP** for Maria and the two-academy catalog.
- **Context:** Demonstrate the original e-commerce assignment without customer-system evidence.
- **Decision:** Build an independent Wandari-aligned simulation with fictional learners, offers and prices.
- **Rationale:** Enables grounded engineering practice without implying customer deployment.
- **Trade-offs:** Synthetic scenarios cannot establish commercial outcomes or real-provider behavior.
- **Consequences:** Label fixtures, status and portfolio claims accurately.
- **Unresolved:** Actual fixture records, prerequisite rules and evaluation cases.

## ADR-002 — NestJS and TypeScript application boundary

- **Status/evidence:** Confirmed target — **CONFIRMED — REPOSITORY** ([stack](../../AGENTS.md)); detailed responsibilities **CONFIRMED — OWNER DAY 0 RECAP**.
- **Context:** API orchestration needs validation, authorization and safe failures.
- **Decision:** NestJS/TypeScript owns HTTP, identity context, policy, tools and response validation.
- **Rationale:** Keeps application enforcement within a backend-controlled boundary.
- **Trade-offs:** Framework structure adds setup; static typing does not validate runtime input.
- **Consequences:** Validate requests and model/tool outputs at runtime.
- **Unresolved:** Endpoint contracts, module structure, validation and database libraries.

## ADR-003 — PostgreSQL catalog authority

- **Status/evidence:** Confirmed target — **CONFIRMED — OWNER DAY 0 RECAP**; PostgreSQL/RDS target corroborated by [README](../../README.md).
- **Context:** Recommendations require factual tenant-owned offers and current simulated prices.
- **Decision:** PostgreSQL owns catalog, prices, metadata and prerequisites.
- **Rationale:** Separate authoritative structured facts from generated language.
- **Trade-offs:** Schema, migration and consistency decisions require explicit ownership.
- **Consequences:** Resolve offer references through authorized database access; model prices confer no authority.
- **Unresolved:** SQL schema, monetary representation, migrations, connection strategy and consistency semantics.

## ADR-004 — Trusted backend tenant and policy enforcement

- **Status/evidence:** Confirmed requirement — **CONFIRMED — REPOSITORY** ([invariants](../../AGENTS.md), [identity template](../../.env.example)); authentication direction **CONFIRMED — OWNER DAY 0 RECAP**.
- **Context:** Caller/model values are untrusted and academies must remain isolated.
- **Decision:** Derive tenant authority from verified server-side context; enforce tenant scope and prerequisites in the backend.
- **Rationale:** Generated text cannot create permissions or eligibility.
- **Trade-offs:** Every query and tool path must retain correct context.
- **Consequences:** Unknown eligibility cannot pass silently; recommendations cannot authorize checkout.
- **Unresolved:** Identity mechanism, database enforcement, audit design and isolation verification.

## ADR-005 — Bounded deterministic Rust ranking

- **Status/evidence:** Confirmed target — **CONFIRMED — REPOSITORY** ([stack](../../AGENTS.md)); candidate boundary **CONFIRMED — OWNER DAY 0 RECAP**.
- **Context:** Authorized suitable candidates need ranking independent of model prose.
- **Decision:** Use Rust for bounded deterministic ranking, with no authorization authority.
- **Rationale:** Supports reproducible computation for defined inputs and rules.
- **Trade-offs:** Introduces cross-language integration and failure handling.
- **Consequences:** Backend eligibility and access decisions precede admission to the candidate set; this does not prescribe model call order.
- **Unresolved:** Rust-to-Node mechanism, score formula, tie-breaking, bounds and benchmarks.

## ADR-006 — Bounded OpenAI assistance

- **Status/evidence:** Confirmed target — **CONFIRMED — REPOSITORY** ([approved tool use](../../AGENTS.md)); responsibilities **CONFIRMED — OWNER DAY 0 RECAP**.
- **Context:** Learner needs and explanations benefit from natural-language assistance.
- **Decision:** Use bounded model/tool interactions for intent and grounded explanations; backend retains factual and policy authority.
- **Rationale:** Permits language assistance without delegating access or checkout decisions.
- **Trade-offs:** Nondeterminism, latency, cost and dependency failures need limits.
- **Consequences:** Validate tool arguments and outputs; preserve safe no-match behavior.
- **Unresolved:** Model, tool contracts, retry/call/token limits, cost measurements and fallback behavior.

## ADR-007 — AWS EC2/RDS deployment target

- **Status/evidence:** Confirmed design target — **CONFIRMED — REPOSITORY** for EC2/RDS; VPC/networking, ALB, IAM and secrets management **CONFIRMED — OWNER DAY 0 RECAP**.
- **Context:** Portfolio scope includes production-style infrastructure design.
- **Decision:** Target EC2 hosting and RDS with the stated networking/security components.
- **Rationale:** Aligns architecture with the assigned target stack.
- **Trade-offs:** Infrastructure brings operational complexity and spending exposure.
- **Consequences:** Provisioning requires separate authorization and evidence; no availability claim follows from component selection.
- **Unresolved:** Topology, sizing, availability-zone strategy, backups, failover, RTO and RPO.

## ADR-008 — Terraform and bounded LocalStack

- **Status/evidence:** Confirmed target — **CONFIRMED — REPOSITORY** ([compatibility constraint](../../README.md)); no Ultimate-only dependency **CONFIRMED — OWNER DAY 0 RECAP**.
- **Context:** Infrastructure learning needs reproducible definitions and limited experimentation.
- **Decision:** Use Terraform and selected LocalStack simulation compatible with intended long-term Base use.
- **Rationale:** Supports bounded experimentation while retaining an infrastructure-as-code boundary.
- **Trade-offs:** Emulator coverage and AWS behavior differ; entitlement is not verified.
- **Consequences:** Record coverage gaps; do not equate simulation with deployment or silently require a paid upgrade.
- **Unresolved:** Compatible service subset, entitlement, versions and experiment scope.

## ADR-009 — Future provider catalog adapter

- **Status/evidence:** Confirmed invariant — **CONFIRMED — REPOSITORY** ([future integration boundary](../../AGENTS.md)); real-provider intent **CONFIRMED — OWNER DAY 0 RECAP**.
- **Context:** Synthetic catalog scope must allow a future authoritative provider integration.
- **Decision:** Preserve an explicit adapter boundary; do not couple policy to invented provider contracts.
- **Rationale:** Keeps future integration explicit without claiming it exists.
- **Trade-offs:** Provider synchronization and authority reconciliation cannot yet be finalized.
- **Consequences:** Provider data remains subject to tenant mapping, validation and checkout revalidation policy.
- **Unresolved:** Provider API, mapping, freshness, ingestion/write strategy and failure semantics.

See [system design](system-design.md) for component relationships, [security](security.md) for proposed controls and [roadmap](roadmap.md) for decision timing. No historical alternative evaluation is asserted.
