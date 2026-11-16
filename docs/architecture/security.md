# Security, correctness and recovery

**All application controls below are architectural requirements or proposed implementations, not implemented or tested controls.** Evidence classes follow the [overview](overview.md). The seven [AGENTS.md invariants](../../AGENTS.md) are **CONFIRMED — REPOSITORY**; component and checkout directions are **CONFIRMED — OWNER DAY 0 RECAP**. Incident procedures below are **PROPOSED** analysis and have never been exercised in P3.

## Trusted tenant and data boundaries

Tenant authority must come from verified server-side authentication/authorization context. Caller/model tenant values grant no permission. Catalog reads and offer-ID lookups must be tenant scoped before facts reach the model or ranker; unauthorized cross-tenant offers must not be exposed. Exact authentication and database enforcement mechanisms are **UNRESOLVED**.

PostgreSQL owns simulated offers, current prices, tenant ownership and prerequisites. Never invent offers or prices. Backend policy enforces prerequisites; unknown eligibility cannot silently become valid. Rust ranks authorized suitable candidates and cannot grant permissions. The future provider adapter must preserve these boundaries; mapping and freshness rules remain unresolved.

## Model and tool boundary

Model output is untrusted. Instructions in catalog content or tool output cannot override tenant or business policy. **PROPOSED:** Allowlisted tools, argument validation, bounded result sizes and catalog-backed validation of returned offer references. Scope all facts before sending them to OpenAI; a response filter cannot undo prior disclosure.

Bound model calls, retries, cost and duration as design requirements. Exact limits and fallback policies are **UNRESOLVED**. Dependency failure must not produce invented results, broader tenant access or waived prerequisites.

## Recommendation and checkout

No suitable offer is a valid and safe response. Distinguish a genuine empty eligible set from an unavailable dependency or unresolved eligibility. Recommendations remain advisory and never authorize checkout.

A future mock handoff requires fresh server-side revalidation of price, eligibility and availability, **followed by explicit user confirmation**. **PROPOSED:** Bind confirmation to those terms and repeat validation/confirmation after material change or expiry. Transaction/reservation semantics and the race between confirmation and handoff are **UNRESOLVED**; no purchase consistency guarantee exists.

## Operational safety and auditability

- Database outage: do not invent catalog facts or report a successful catalog-backed operation. Exact response contract is unresolved.
- Model outage: preserve policy; an explicit unavailable response or deterministic fallback requires a later decision. Do not mislabel failure as no match.
- Provider outage: preserve the adapter boundary; freshness/stale-data policy must be decided before integration.
- Secrets and learner data: minimize collection and exposure; never place credentials in model context, logs or responses. Access, retention and rotation policies remain unresolved.
- **PROPOSED:** Tenant-aware audit events for access, policy outcomes, catalog versions, tool actions and confirmation, with restricted access and redacted payloads. Logging is not permission to retain full prompts or cross-tenant data.
- **PROPOSED:** Contain incidents by disabling affected paths/integrations, restricting access and identifying potentially affected tenants without spreading their data.

**Actually implemented:** D1.1 contains [ignore rules](../../.gitignore), a placeholder-only [configuration template](../../.env.example) and a bounded [environment checker](../../scripts/check-env.mjs). [Historical verification](../verification/D1.1.md) covers those limited harness controls. It does not establish application authentication, tenant isolation, eligibility, production secret management or recovery readiness.

## Catastrophic failures and disaster recovery

These are proposed response directions, not an executed runbook. Collect minimal authorized evidence, preserve relevant versions and avoid exposing additional tenant data while investigating. **RTO and RPO are UNRESOLVED for every scenario.** No backup, restore, Multi-AZ or failover capability is claimed.

| Scenario / expected symptoms | Evidence to collect | Immediate containment | Durable mitigation direction | Recovery verification | Blast radius |
| --- | --- | --- | --- | --- | --- |
| Wrong-tenant exposure: foreign offers appear in responses, tool context or diagnostics | Trusted identity context, scoped access events, affected IDs, query/tool/cache paths; restricted handling | Disable affected access path; stop further disclosure; preserve evidence | Enforce tenant scope at every data boundary; decide database defenses and test isolation | Exercise permitted/forbidden tenant cases and inspect downstream model/log/cache paths | Potentially multiple tenants; determined by affected paths and recipients |
| Hallucinated offer/price: response conflicts with catalog | Authorized catalog snapshot/version, generated references, validation outcomes and minimal redacted model evidence | Suppress unsupported result; block related handoff | Validate references and prices against authority; test grounding and adversarial input | Confirm all displayed offers/prices resolve within authorized catalog; reject injected/fabricated values | Recipients of affected responses; broader if reused through caches |
| Database outage: failed reads or unavailable catalog | Sanitized connection errors, request correlation and dependency health evidence | Fail safely; stop operations requiring fresh catalog facts | Decide connection limits, timeout behavior and authorized backup/restore strategy | Verify connectivity, schema/data integrity and tenant-scoped reads before resuming | All users of affected database/service; topology unresolved |
| Stale checkout data: price, eligibility or availability changed | Revalidation result/version, confirmed terms and handoff timing, without unnecessary personal data | Halt handoff; revalidate and obtain explicit confirmation of current terms | Decide expiry, concurrency and provider reservation/transaction boundary | Change terms during the flow; verify no silent handoff with stale authority | Affected offers and in-flight handoffs |
| Availability-zone/infrastructure failure: application or database unreachable | Authorized infrastructure health, dependency timeline and known backup/restore metadata | Suspend unsafe actions; use only separately authorized recovery operations | Choose availability strategy, backup retention, restore procedure and failure-domain isolation | Exercise restore/failover only after authorization; verify integrity, tenant isolation and full request path | Depends on unresolved topology; no assumed zone redundancy |

See [decisions](decisions.md) for unresolved mechanisms, [system design](system-design.md) for boundaries and [roadmap](roadmap.md) for authorization gates.
