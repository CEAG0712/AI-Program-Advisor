# P3 AI Program Advisor

An independent, synthetic **AI Backend Engineering / Forward Deployed Engineering** portfolio simulation, aligned with the original Wandari **Intelligent Agent for E-commerce** assignment. The evidence covers a fictional academy catalog and controlled engineering tests.

## Status and target

The NestJS/TypeScript application uses a synthetic PostgreSQL course catalog. Demo bearer authentication establishes tenant identity on the server. `GET /health` reports process health, and authenticated `GET /catalog/offers` returns active offers for that tenant. Authenticated `POST /recommendations` filters by budget, available study time and exact declared prerequisites, then ranks eligible offers deterministically. PostgreSQL supplies fixture prices and prerequisites. See the [D1.2 catalog record](docs/verification/D1.2.md) and [D1.3 recommendation evidence](docs/verification/D1.3.md).

The policy establishes synthetic course suitability using self-declared skills. Verified admission, production identity, database Row-Level Security (RLS), provider catalog ingestion, checkout, deployment and operational reliability work remain future scope. The Day 0 architecture targets Amazon Web Services (AWS), including Elastic Compute Cloud (EC2) and Relational Database Service (RDS), with Terraform and bounded LocalStack experiments. LocalStack Base compatibility remains unverified. [Architecture overview](docs/architecture/overview.md) · [Business invariants](AGENTS.md)

### Day 4 infrastructure evidence

The AWS Terraform foundation passed offline validation and one mocked topology test with ten assertions. A separate LocalStack Community 4.14.0 exercise created, inspected and removed the VPC and application subnet. Terraform ended with zero managed resources, and both exact IDs were absent from the emulator. Real AWS deployment remains unverified. [LocalStack diagram](docs/architecture/d4-localstack.svg) · [Verification and cleanup](docs/verification/D4-localstack.md)

### Advisor implementation and evidence

The advisor validates `find_suitable_courses` proposals against confirmed constraints before dispatching a single tenant-scoped lookup. Bounded two-phase orchestration supports a local fake model and a real OpenAI Responses API adapter. The server renders recommendations from authorized database facts and can use deterministic fallback when a final model explanation fails validation or is unavailable after a successful read.

Ordinary application startup leaves the advisor disabled. The OpenAI adapter and the explicit experimental latency profile are selected through server-owned composition. HTTP parameters confer no control over either setting. [Application composition](src/app.module.ts) · [Normal entrypoint](src/main.ts)

With advisor composition enabled, send a demo bearer credential and `Content-Type: application/json` to `POST /advisor/recommendations`. The route accepts exactly `confirmed: true` and a `constraints` object with all three fields below. Natural-language intake was deferred for this increment.

```json
{
  "confirmed": true,
  "constraints": {
    "budget_cents": 30000,
    "weekly_hours": 6,
    "known_skills": ["basic-python"]
  }
}
```

| Earlier Day 2 verification | Observed result |
| --- | --- |
| Gate 2 offline unit and mocked integration tests | **238 passed, zero failed, zero skipped.** |
| B3B-2B real PostgreSQL with a fake model | In-process HTTP verified both tenant scopes and preserved all six fixture rows. |
| B3C-2B initial OpenAI attempt | The 2-second initial deadline expired, returning HTTP 504 with zero business SQL dispatches. |
| B3C-2G experimental OpenAI and PostgreSQL acceptance | One synthetic request completed with grounded recommendations under the explicit 30-second overall profile. The default overall deadline remains 6 seconds. |

The controlled live success establishes neither an operational latency service-level objective (SLO) nor a production deployment.

- [HTTP-to-PostgreSQL sequence](docs/architecture/b3b-http-postgresql-sequence.md)
- [Tenant trust boundaries](docs/architecture/b3b-tenant-trust-boundaries.md)
- [B3 implementation and verification status](docs/architecture/b3-gate-implementation-status.md)

### Day 3 Rust ranking

**D3-R1** implements a standalone Rust executable with a versioned JSON protocol over standard input and output. It validates up to 1,000 candidates and returns up to ten offer identifiers (IDs), ordered by weekly study hours descending, then price in cents ascending, then ID in JavaScript-compatible UTF-16 code-unit order. It caps input at 1 MiB and output at 10 KiB and emits sanitized failure diagnostics. [Rust ranker](rust/ranker/src/main.rs)

**D3-R2** adds an optional server-owned `rustRankerPath` composition setting. Normal startup still uses TypeScript ranking. TypeScript reads the authenticated tenant's catalog and applies the existing suitability rules. Rust receives only the eligible offer IDs, prices, and weekly study hours. The adapter verifies exact parity with the TypeScript ranking, and the recommendation service reconstructs the response from authorized catalog records. Each application allows two active ranking children and refuses additional work immediately, with zero retries. Each child has a configured 500 ms deadline, a 1 MiB input cap, a 10 KiB standard-output cap, a 4 KiB standard-error cap, and cancellation and shutdown cleanup. Ranking failures return sanitized unavailable outcomes. [Server composition](src/app.module.ts) · [Rust adapter](src/recommendations/rust-ranker.ts) · [Recommendation service](src/recommendations/recommendations.service.ts)

**Unicode correction** aligns advisor ID validation with the PostgreSQL and Rust limit of 80 Unicode code points. The advisor rejects empty IDs, malformed Unicode, embedded null characters, overlength IDs, and duplicates. With the real Rust executable and fake PostgreSQL and model dependencies, both recommendation routes returned the same authorized offer, including an ID of 80 supplementary-plane code points. [Advisor validation](src/ai/advisor.service.ts) · [Composed test](tests/advisor.executor.unit.test.ts)

**Retained Day 3 verification** recorded 279 offline Node.js tests passed with zero failures or skips, 20 Rust tests passed with zero failures, successful TypeScript typecheck and build, and a successful Rust release build and format check. The optional Clippy command could not run because the component was unavailable. Day 3 left real PostgreSQL and provider integration, clean-machine portability, and production behavior unverified. [Day 3 verification record](docs/verification/D3-rust-ranking.md)

| Candidates | TypeScript median | Full Rust adapter median |
| ---: | ---: | ---: |
| 7 | 0.005 ms | 2.881 ms |
| 1,000 | 0.024 ms | 4.645 ms |

The local test used 25 paired measurements per fixture. The adapter measurement includes process launch, serialization, the TypeScript reference sort, response parsing, and parity checks. TypeScript was faster in both tested workloads and remains the default. The measurements do not establish a production service-level objective. [Benchmark methodology](docs/verification/D3-rust-ranking.md#benchmark)

## Development and verification

Use Node.js 24.x, npm 11.x and Git. npm is the package manager. Exact NestJS, PostgreSQL driver, TypeScript and typing versions are locked.

### Proposed Day 3 reproduction

Use a Rust toolchain that supports edition 2024, a native linker, and `rustfmt` alongside Node.js 24 and npm 11. On a supported shell, the following recipe uses locked packages and a locally built release executable. Initial dependency retrieval requires authorized network access or populated caches. With the Cargo dependencies cached, add `--offline` to the Cargo build and test commands. The Node.js suite uses fake dependencies and requires no database, model service, or credentials. This recipe was derived from the retained runs and has not been verified on a clean machine. The ordinary `npm run test:unit` script runs the catalog unit file only.

```sh
npm ci --ignore-scripts --no-audit --no-fund
export CARGO_TARGET_DIR="$PWD/rust/ranker/target"
cargo build --manifest-path rust/ranker/Cargo.toml --locked --release
cargo fmt --manifest-path rust/ranker/Cargo.toml --check
cargo test --manifest-path rust/ranker/Cargo.toml --locked
npm run typecheck
node node_modules/typescript/bin/tsc --noEmit false --outDir dist/b3c2-day3 --incremental false
P3_D3_R2_RANKER="$CARGO_TARGET_DIR/release/p3-ranker" \
  P3_B3C2_TEST_BUILD=dist/b3c2-day3 \
  node --test --test-concurrency=1 dist/b3c2-day3/tests/*.unit.test.js tests/b3c2-runner.offline.test.mjs
```

### TypeScript development

Ordinary development workflow, with dependency installation authorized:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run check:env
npm run verify
```

`verify` combines type checking and environment inspection. Normal npm workflows may create local cache/log artifacts and perform update-notifier checks; they are not guaranteed to be strictly read-only.

For stricter local inspection with dependencies already installed, bypass npm wrappers and disable Node compile caching:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node node_modules/typescript/bin/tsc --noEmit --incremental false
NODE_DISABLE_COMPILE_CACHE=1 node scripts/check-env.mjs
```

The checker also forces `NODE_DISABLE_COMPILE_CACHE=1` for child processes, including npm version inspection. It does not load `.env`, print credential values, install software or start services. It queries Docker only when the selected endpoint is a local Unix socket. These controls limit known side effects; they do not guarantee that every external tool or operating-system behavior is side-effect-free.

Missing future tools do not fail D1.1. The checker inspects the repository containing this script; it does not require a commit or clean working tree. Failed Docker queries report sanitized `ACCESS_DENIED`, `CONNECTION_UNAVAILABLE`, `TIMEOUT` or `UNKNOWN_FAILURE` categories without inferring whether the daemon is stopped. Successful queries report `AVAILABLE`.

`.env.example` documents placeholder configuration. The D1.1 harness requires no AWS or OpenAI credentials. The local catalog and advisor use server-derived demo tenant identity.

Initial D1.1 verification reported Docker unavailable. Subsequent acceptance review distinguished sandbox access denial from daemon state and observed server version 28.5.1 through an approved read-only query. PostgreSQL readiness and tool availability were unresolved at that checkpoint. See the [D1.1 evidence](docs/verification/D1.1.md) for historical observations and the D1.2 section below for later database verification.

## D1.2 local setup and verification

D1.2 subsequently verified PostgreSQL 17.12 and real HTTP catalog reads; the preceding paragraph preserves the D1.1 observation. This is a local portfolio simulation with fictional inventory and prices, not provider catalog data or a deployed service. Demo credentials are not production identity management. Prerequisites are metadata, not an eligibility decision. The future provider adapter remains an architectural boundary.

The [D1.2 configuration template](config/d1.2.env.example) documents the required variables and contains placeholders. The demo expects two distinct URL-safe bearer credentials of 32–256 characters. The test requires the dedicated `p3_d12` database and role at `127.0.0.1:55432`.

Check for existing P3 container/volume and port conflicts before startup. Only operate against a verified local Docker context. The Compose file pins the observed PostgreSQL image digest, binds `127.0.0.1:55432`, and uses container `p3-d12-postgres` and persistent volume `p3-d12-data`. Do not adopt or overwrite unknown data. With local operations authorized:

```sh
npm ci --ignore-scripts --no-audit --no-fund
docker compose up -d --wait --wait-timeout 60
npm run test:unit
D1_2_INTEGRATION=1 npm run test:integration
npm run verify
npm run build
npm start
```

The integration command initializes only the dedicated catalog using `db/schema.sql` and `db/seed.sql`. It rejects unexpected offer IDs, checks fixed fixture ownership/prices/activity, tests repeatable seeding and temporarily deactivates/restores Academy B fixtures to verify a real empty catalog. Run it serially on this disposable local fixture database, never alongside an active demo. It starts and closes temporary localhost HTTP applications, including a connection-failure test against an unused local port; it does not stop PostgreSQL. It fails rather than substituting mocks when real PostgreSQL is unavailable.

`npm start` binds the demo API to `127.0.0.1`, using `PORT` (default 3000). `/health` is public process health and does not establish database readiness. Send `Authorization: Bearer <private demo credential>` to `/catalog/offers`; tenant query/header values cannot change scope. Successful responses are arrays of database fields (`offer_id`, `title`, `price_cents`, `currency`, `required_skills`, `weekly_study_hours`), ordered by offer ID. Empty scope is HTTP 200 with `[]`; invalid authentication is 401; database request failure is a sanitized 503. Catalog responses carry `Cache-Control: no-store`. `POST /recommendations` is described below.

Ctrl-C stops the foreground API. `docker compose stop postgres` stops this project's database and retains its persistent volume. Host-context permission may be required where the sandbox blocks Docker or localhost networking.

## Review and future publication

The Day 3 implementation, Unicode correction, and documentation completed independent review. Publication is a separately authorized operation. Review the complete approved file set and publication audit before staging. After authorized publication, independently verify the remote commit and file set and record the evidence. [Day 3 publication status](docs/verification/D3-rust-ranking.md#security-and-publication)

For session recovery, follow AGENTS.md, inspect Git and the verification record, and obtain the next increment's authorization. Day 1 has a 240-minute ceiling; the original 45-minute harness allocation includes D1.0. Total implementation is limited to 20 hours with a provisional $15 spending ceiling. Record measured work, not inferred time.

**TRAINING WHEELS ON:** guided implementation and Codex explanations. **TRAINING WHEELS OFF:** the engineer independently reviews source, chooses verification, manages risk and owns the change. Generated output does not establish mastery.

## D1.3 recommendations and verification

Send `Content-Type: application/json` (optionally `; charset=utf-8`) and the existing private demo bearer credential to `POST /recommendations`:

```json
{"budget_cents":30000,"weekly_hours":6,"known_skills":["basic-python"]}
```

All three keys are required; unknown keys, including tenant or policy authority, are rejected. Budget is an uncoerced safe integer from 0 to 100000000 USD cents. Weekly hours is an integer from 1 to 168. Skills are 0–32 unique lowercase letter/digit identifiers separated by single hyphens, at most 64 characters each; whitespace/case variants are rejected. An empty skills list declares no skills. Missing skills is invalid. The JSON parser's existing 100 KiB body limit is retained; malformed, oversized or unsupported bodies produce a fixed 400 response on this route.

The verified credential selects the tenant. Caller query/header tenant values confer no authority; body authority fields fail validation. The shared repository selects active offers for that tenant with bound SQL parameters. At most 1000 active candidates are supported; fetching a 1001st sentinel row causes a sanitized 503 refusal rather than ranking an incomplete page. Non-USD offers are excluded because the request budget is USD. Every prerequisite must match an explicitly declared skill exactly.

Eligible offers rank by weekly hours descending, price cents ascending, then offer ID in ascending JavaScript code-unit order. This is a transparent capacity-use preference, not learned suitability. At most ten recommendations are returned with stored fields and three fixed policy reasons. Maria receives `p3-a-102` then `p3-a-101`. Results do not verify competence, admission, enrollment, reservation, availability or checkout permission. PostgreSQL facts are current at query time; no future price guarantee is made. The provider catalog integration remains a future boundary.

Success is 200 with `{"recommendations":[...]}`; a valid no-match is 200 with `{"recommendations":[]}`. Invalid input is sanitized 400, invalid credentials 401, and database failure or candidate overflow 503. Recommendation responses carry `Cache-Control: no-store`, including tested errors. Raw learner bodies and credentials are not logged by the new code. A malformed body may fail in parsing before authentication runs.

With dependencies already installed and the approved private environment supplied, use:

```sh
npm run verify
npm run test:unit
npm run test:recommendations:unit
D1_2_INTEGRATION=1 npm run test:integration
D1_3_INTEGRATION=1 npm run test:recommendations:integration
npm run build
```

Run integration suites only with local verification authorized, serially against the dedicated database at `127.0.0.1:55432` with no active demo. D1.2 tests initialize and check fixtures and temporarily change activity. D1.3 tests are read-only and refuse any deviation from all six expected fixture rows. Both close their owned applications and pools. Preserve the database and fixtures when diagnosing verification failures.
