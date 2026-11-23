# D5-R1 evidence-first reliability closeout

**ACCEPT WITH CAVEATS — synthetic portfolio simulation.**

Day 5 supports a documentation-only closeout. The existing tests exercise the two incident paths below, and verification found no critical regression or application defect requiring a repair increment.

## Baseline and environment

On November 23, 2026 (Panama), the working directory and Git root matched the `p3-intelligent-agent-for-e-commerce` workspace. Branch `main` and the local `origin/main` tracking ref both pointed to `4d329b87413893a4dd54ee508995aa1c35abbd25`, with zero commits ahead or behind. Git reported a clean worktree and staging index before and after D5-R1. The configured origin was `CEAG0712/AI-Program-Advisor` on GitHub. The comparison used the local tracking ref.

D5-R1 used macOS 27.2 (build `26B123`) on arm64, Node.js `v24.22.0`, npm `11.19.1` and installed TypeScript `5.9.3`. The D5-R2 documentation increment records the accepted D5-R1 results.

## Acceptance criteria

| Criterion | Evidence and result |
| --- | --- |
| 1. Authenticated tenant isolation | **Fresh offline pass.** Both demo credentials selected their server-derived scope. The composed tests verified the active-catalog SQL and bound tenant parameter. Body and model tenant claims were rejected, and query and header claims could not change scope. Day 2 separately exercised both scopes with real local PostgreSQL. [Credential resolver](../../src/catalog/demo-auth.guard.ts#L9) · [SQL](../../src/catalog/catalog.repository.ts#L9) · [Composed tests](../../tests/advisor.executor.unit.test.ts#L172) · [Day 2 PostgreSQL evidence](../architecture/b3-gate-implementation-status.md#b3b-2b-postgresql-acceptance) |
| 2. Authoritative catalog offers and prices | **Fresh offline pass.** Composed responses matched authorized fixture rows field for field. The response tests rejected a foreign offer ID and an injected price and preserved the original facts. [Fact rendering](../../src/ai/response.policy.ts#L51) · [Row equality assertions](../../tests/advisor.executor.unit.test.ts#L200) · [Invalid explanation tests](../../tests/advisor.unit.test.ts#L129) |
| 3. Backend budget and prerequisite enforcement | **Fresh offline pass.** The backend excluded over-budget, over-hours, non-USD and missing-prerequisite offers. Empty declared skills still allowed offers with no prerequisites. [Suitability policy](../../src/recommendations/recommendations.policy.ts#L42) · [Composed policy tests](../../tests/advisor.executor.unit.test.ts#L241) |
| 4. Safe invalid and unsuitable outcomes | **Fresh offline pass.** Invalid credentials returned `401`, invalid requests returned `400`, a rejected tool proposal returned `502` before SQL, and successful no-match requests returned `200` with an empty list. [HTTP mapping](../../src/ai/advisor.controller.ts#L22) · [Authentication and body tests](../../tests/advisor.executor.unit.test.ts#L207) · [Tool rejection](../../tests/advisor.executor.unit.test.ts#L232) · [No-match tests](../../tests/advisor.executor.unit.test.ts#L272) |
| 5. Controlled dependency failure | **Fresh offline pass.** An injected SQL rejection returned sanitized `503` after one read attempt and prevented the final model call. A simulated business timeout prevented continuation after late settlement. A final model timeout after a successful read preserved the authorized facts. [Failure handling](../../src/ai/advisor.service.ts#L225) · [SQL rejection test](../../tests/advisor.executor.unit.test.ts#L272) · [Deadline tests](../../tests/advisor.orchestration.unit.test.ts#L175) |
| 6. Correct default TypeScript ranking | **Fresh offline pass.** Tests verified hours descending, price ascending, then offer ID in UTF-16 code-unit order, with a ten-result cap. The default composition spawned no Rust child even when a request tried to select Rust. [Default branch](../../src/recommendations/recommendations.service.ts#L13) · [Comparator and cap tests](../../tests/recommendations.unit.test.ts#L62) · [Default composition test](../../tests/advisor.executor.unit.test.ts#L301) |
| 7. Accurate published Rust and LocalStack evidence | **Published records checked.** Day 3 records opt-in Rust and retained release-binary verification. D5-R1 exercised the Node adapter with stand-in executables. Day 4 records one mocked Terraform plan with ten assertions and a separate LocalStack Community 4.14.0 exercise that created, inspected and removed one VPC and one application subnet. Final Terraform state was empty, and both exact IDs were absent from the emulator. [Rust adapter](../../src/recommendations/rust-ranker.ts#L42) · [Fixture test](../../tests/rust-ranking.unit.test.ts#L83) · [Day 3 results](D3-rust-ranking.md#retained-verification) · [Mock topology test](../../infra/aws/tests/topology.tftest.hcl#L1) · [Terraform foundation](D4-R2-infrastructure.md#retained-offline-follow-up) · [LocalStack cleanup](D4-localstack.md#authorized-resource-cleanup-results) |

## Fresh D5-R1 verification

| Check | Exit | Passed / failed / skipped | Wall time |
| --- | ---: | ---: | ---: |
| Strict TypeScript typecheck | 0 | — | 1.78 s |
| Fresh TypeScript compilation | 0 | — | 1.84 s |
| Corrected offline suite | 0 | 273 / 0 / 2 | 4.30 s |
| Supplemental offline cases | 0 | 16 / 0 / 0 | 0.67 s |
| **Combined final test results** | — | **289 / 0 / 2** | — |

The first offline attempt exited `1` in 4.83 s with 272 passes, one failure and two skips. Its `TMPDIR` placed the executable fixtures inside the temporary build's ESM package root, and the Rust adapter test for exact pipe limits failed. The full rerun used `TMPDIR=/private/tmp` outside the package root and passed without code or test edits. The initial run is excluded from the combined total.

D5-R1 adapted the serial Day 3 procedure below. `verify_dir` denotes the temporary build root and `p3_node` the absolute Node executable. Typecheck and compilation ran from the Git root. Test invocations ran from the temporary root, with the installed dependencies linked and byte-identical copies of the package manifest, acceptance runner and runner test. [Day 3 procedure](D3-rust-ranking.md#retained-verification)

```bash
NODE_DISABLE_COMPILE_CACHE=1 /usr/bin/time -p node \
  node_modules/typescript/bin/tsc --noEmit --incremental false
NODE_DISABLE_COMPILE_CACHE=1 /usr/bin/time -p "$p3_node" \
  node_modules/typescript/bin/tsc --noEmit false --outDir "$verify_dir/dist/b3c2-d5" --incremental false

/usr/bin/time -p /usr/bin/env -i PATH=/usr/bin:/bin TMPDIR=/private/tmp \
  NODE_DISABLE_COMPILE_CACHE=1 P3_B3C2_TEST_BUILD=dist/b3c2-d5 \
  "$p3_node" --test --test-concurrency=1 --test-reporter=spec \
  dist/b3c2-d5/tests/*.unit.test.js tests/b3c2-runner.offline.test.mjs

/usr/bin/time -p /usr/bin/env -i PATH=/usr/bin:/bin TMPDIR=/private/tmp \
  NODE_DISABLE_COMPILE_CACHE=1 "$p3_node" --test --test-concurrency=1 --test-reporter=spec \
  --test-name-pattern='cleanup regression|cleanup retains body|parser sanitizer regression|B3B2 offline safety' \
  dist/b3c2-d5/tests/{catalog,recommendations,advisor.db}.integration.test.js
```

The two skips were the release-Rust composed HTTP case and the release-Rust parity and benchmark case. The supplemental filter selected cleanup, request-parser sanitation and database target and fixture safety cases. It excluded all three live PostgreSQL cases from the test runner's counts. [Composed Rust case](../../tests/advisor.executor.unit.test.ts#L320) · [Parity and benchmark case](../../tests/rust-ranking.unit.test.ts#L155) · [Cleanup](../../tests/catalog.integration.test.ts#L21) · [Parser](../../tests/recommendations.integration.test.ts#L97) · [Database target and fixture checks](../../tests/advisor.db.integration.test.ts#L130)

## Authenticated customer journey

| Technical source | First-person business reasoning |
| --- | --- |
| `createApplication(config)` starts ordinary composition with the advisor disabled. Server-owned composition enables `POST /advisor/recommendations`. The direct `POST /recommendations` route remains available. [Entrypoint](../../src/main.ts#L4) · [Composition](../../src/app.module.ts#L54) · [Advisor route](../../src/ai/advisor.controller.ts#L49) · [Direct route](../../src/recommendations/recommendations.controller.ts#L32) | I receive a structured request when the operator enables the advisor. I can still serve direct recommendations under ordinary startup. |
| `DemoAuthGuard.canActivate` resolves the bearer credential and attaches the server-owned tenant. `AuthenticatedTenant` reads that scope. [Guard](../../src/catalog/demo-auth.guard.ts#L22) · [Tenant context](../../src/catalog/tenant-context.ts#L5) | I identify the customer's academy from their demo credential and carry that scope into the lookup to protect each academy's inventory. |
| `AdvisorController.recommendations` requires `confirmed: true` and exact constraints. `validateRecommendationRequest` checks the budget, time and skills. [Controller](../../src/ai/advisor.controller.ts#L55) · [Validation](../../src/recommendations/recommendations.policy.ts#L15) | I accept the customer's confirmed budget, weekly study time and declared skills as the basis for assessing suitability. |
| `AdvisorService.advise` allows one `find_suitable_courses` proposal. `validateToolProposal` requires an exact match to confirmed constraints. `RecommendationsExecutor.execute` forwards the authenticated tenant separately. [Orchestration](../../src/ai/advisor.service.ts#L192) · [Tool contract](../../src/ai/tool.contract.ts#L29) · [Executor](../../src/ai/advisor.executor.ts#L13) | I let the model propose a single lookup. I check it against the customer's declarations and retain control of the academy scope. |
| `CatalogRepository.recommendationCandidates` binds the tenant and reads only active rows with a 1,001-row sentinel. `suitableOffers` requires USD, budget and hours within limits, and every prerequisite. [SQL](../../src/catalog/catalog.repository.ts#L9) · [Bounded read](../../src/catalog/catalog.repository.ts#L25) · [Policy](../../src/recommendations/recommendations.policy.ts#L42) | I take prices and prerequisites from the active catalog. I exclude unsuitable courses and return unavailable if the 1,000-candidate bound is exceeded. |
| `RecommendationsService.recommendations` defaults to `recommend`. `compareRankingCandidates` applies hours, price and the offer ID tie-breaker before the result is capped at ten. [Default branch](../../src/recommendations/recommendations.service.ts#L13) · [Ranking policy](../../src/recommendations/recommendations.policy.ts#L36) | I return up to ten eligible offers in a consistent order so the same inputs can produce the same recommendation order. |
| `factsFrom` validates the result. `groundResponse` serves authorized facts and fixed reasons even if the explanation fails validation. The controller returns bounded JSON with `Cache-Control: no-store`. [Fact checks](../../src/ai/advisor.service.ts#L105) · [Grounding](../../src/ai/response.policy.ts#L63) · [Response mapping](../../src/ai/advisor.controller.ts#L75) | I show catalog facts, return an empty list after a successful no-match search, and show a sanitized error when the lookup fails. |

## Senior/Staff incident defenses

### AI fabricates an offer or price

| Technical source | First-person business reasoning |
| --- | --- |
| **Business impact.** `copyFacts` owns the title, price and currency in the response. [Rendering](../../src/ai/response.policy.ts#L51) | I protect the customer's decision about what to study and what they can afford. A fictional course or false price can waste their time and distort their budget. |
| **Evidence.** `validateToolProposal` rejects extra fields or changed constraints. `validateExplanationPlan` requires exact authorized IDs in order and fixed reason IDs. [Tool validation](../../src/ai/tool.contract.ts#L29) · [Explanation validation](../../src/ai/response.policy.ts#L32) | I identify whether the model changed the proposed lookup or tried to change the explanation after a successful read. |
| **Containment.** Invalid tool proposals stop before SQL. Invalid final plans use `deterministicFallback` with successful authorized facts. [Dispatch boundary](../../src/ai/advisor.service.ts#L203) · [Fallback](../../src/ai/response.policy.ts#L63) | I block the invalid lookup and discard the fabricated explanation. If the lookup succeeded, I can still return the correct offers and prices. |
| **Recovery.** `factsFrom` validates and detaches the catalog result before sending it to the final phase. [Fact snapshot](../../src/ai/advisor.service.ts#L105) | I serve that snapshot for the affected request. If a customer reports an actual price discrepancy, I compare the delivered result with the tenant's catalog and trace the source. |
| **Verification.** Fresh tests inject a foreign offer ID, an invented ID and an extra price. They assert the original facts and deterministic fallback. [Response tests](../../tests/advisor.unit.test.ts#L129) · [Orchestration tests](../../tests/advisor.orchestration.unit.test.ts#L329) | I check the exact customer-visible fields and the fallback path. |
| **Residual risk.** The executor supplies authoritative data for the response. A future presentation layer must escape catalog text for its context. [Executor contract](../../src/ai/advisor.service.ts#L19) · [Presentation boundary](../../src/ai/response.policy.ts#L60) | I still depend on catalog quality, correct scope and safe presentation. The recommendation carries no admission or checkout authority. |

### PostgreSQL is unavailable during an advisor request

| Technical source | First-person business reasoning |
| --- | --- |
| **Business impact.** The composed test distinguishes a successful empty result from a rejected database read. [Boundary test](../../tests/advisor.executor.unit.test.ts#L272) | I tell the customer the search is temporarily unavailable. An empty recommendation list would wrongly suggest I searched the catalog and found nothing suitable. |
| **Evidence.** The repository redacts the query error. The advisor maps business rejection to `503 ADVISOR_UNAVAILABLE` and advisor deadline expiry to `504 ADVISOR_TIMEOUT`. [Repository](../../src/catalog/catalog.repository.ts#L25) · [Service mapping](../../src/ai/advisor.service.ts#L225) · [HTTP mapping](../../src/ai/advisor.controller.ts#L22) | I distinguish a rejected read from a deadline and protect the customer-facing response from database diagnostics. |
| **Containment.** One business dispatch precedes fact validation and the final model phase. [Dispatch and final phase](../../src/ai/advisor.service.ts#L209) | I stop after the failed lookup. I keep retries and model-generated guesses out of that request. |
| **Recovery.** `GET /health` reports process health. The authenticated recommendation path exercises the actual catalog dependency. [Health](../../src/health.controller.ts#L3) · [Repository](../../src/catalog/catalog.repository.ts#L25) | After an authorized operator restores connectivity, I check an authenticated lookup for each academy and verify that expected offers and prices return. |
| **Verification.** The fake pool returned an injected rejection, and the test asserted one SQL attempt, sanitized `503` and no final model call. The fake clock tested late settlement after a deadline. [Rejection test](../../tests/advisor.executor.unit.test.ts#L272) · [Deadline test](../../tests/advisor.orchestration.unit.test.ts#L175) | I can demonstrate application containment offline. I would use a separately authorized live exercise to measure database recovery. |
| **Residual risk.** The pool has connection and query timeouts. A query already underway can continue after advisor cancellation. [Pool configuration](../../src/app.module.ts#L86) · [Cancellation boundary](../../src/recommendations/recommendations.service.ts#L13) | I can bound the advisor's wait in the tested flow. Database recovery time, failover and pool behavior under outage load remain unverified. |

## Remaining limitations

- **Identity and data.** Demo credentials and tenant-scoped queries establish the tested application boundary. Production identity and PostgreSQL Row-Level Security (RLS) remain outside the implementation. The catalog is synthetic. Provider catalog ingestion, verified admission and checkout remain future scope. [Project scope](../../README.md#status-and-target)
- **Live dependencies.** D5-R1 ran offline. Day 2 retains the controlled local PostgreSQL acceptance with a fake model, a default-profile OpenAI timeout and one synthetic OpenAI and PostgreSQL success under an experimental latency profile. This evidence leaves ongoing provider behavior and live database recovery unverified. [Day 2 record](../architecture/b3-gate-implementation-status.md#b3b-2b-postgresql-acceptance)
- **Real Rust.** The release executable and benchmark were outside Day 5 verification. Day 3 retains real-binary evidence with fake database and model dependencies. [Day 3 limitations](D3-rust-ranking.md#limitations)
- **AWS and operational recovery.** Day 5 reviewed the committed Day 4 record. The original temporary artifact directories were unavailable at their recorded paths. The mocked Terraform topology and two-resource LocalStack exercise leave real AWS deployment, EC2 runtime, RDS, IAM enforcement, availability and operational recovery unverified. [Day 4 scope](D4-localstack.md#scope-and-plan-results) · [Day 4 cleanup](D4-localstack.md#authorized-resource-cleanup-results)

**Final verdict: ACCEPT WITH CAVEATS — synthetic portfolio simulation.**
