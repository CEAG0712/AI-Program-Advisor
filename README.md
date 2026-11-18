# P3 AI Program Advisor

An independently implemented, Wandari-aligned portfolio simulation of the original **Intelligent Agent for E-commerce** assignment. This is not a claim of customer deployment or verified production work.

## Status and target

Current implementation: **D1.1 harness, D1.2 local NestJS/PostgreSQL catalog and D1.3 deterministic recommendations**, pending independent review. `GET /health` reports process health; authenticated `GET /catalog/offers` returns active synthetic offers scoped to server-authenticated demo tenants. PostgreSQL owns fixture prices and prerequisite metadata. Authenticated `POST /recommendations` validates learner input, filters tenant-authorized active offers by USD budget, weekly hours and exact declared prerequisite skills, then ranks deterministically. This establishes suitability under a synthetic declared-skill policy only. Verified admission eligibility, Rust, live model integration, provider ingestion and checkout remain unimplemented. See [D1.3 evidence and limitations](docs/verification/D1.3.md) and the preserved [D1.2 record](docs/verification/D1.2.md).

The production-target architecture was designed during Day 0 according to the owner and is documented in [the architecture overview](docs/architecture/overview.md). The assigned target is a NestJS/TypeScript API, PostgreSQL on RDS, deterministic Rust ranking, OpenAI approved tool calling, and EC2 hosting, with Terraform and bounded LocalStack simulation later. LocalStack must fit the intended long-term Base plan; feature compatibility is currently unknown.

Status words have distinct meanings:

| Term | Meaning and current evidence |
| --- | --- |
| Designed | Target decisions; not proof of executable behavior |
| Implemented | Harness, local demo catalog, recommendation API, and advisor composition for local acceptance |
| Tested | Executed Day 1 checks in the verification records and reported B3 advisor acceptance |
| Emulated | No AWS services have been emulated |
| Deployed | Nothing has been deployed |

The seven business invariants and authorization rules are in [AGENTS.md](AGENTS.md). D1.2 implements demo authentication, tenant-scoped catalog access and stored price authority; D1.3 implements bounded declared-skill suitability and recommendations; admission verification, checkout and provider integration remain future requirements.

### Advisor implementation and evidence

The server-selected `fake-model-postgres` acceptance mode connects the authenticated advisor route and a local fake model to real PostgreSQL catalog reads. The normal application entrypoint leaves the advisor disabled. B3B-2B reported two passing tests, including in-process HTTP acceptance against local PostgreSQL. The acceptance checked both synthetic tenant scopes, grounded recommendations, and preservation of all six fixture rows. The Day 0 architecture describes the production target.

- [HTTP-to-PostgreSQL sequence](docs/architecture/b3b-http-postgresql-sequence.md)
- [Tenant trust boundaries](docs/architecture/b3b-tenant-trust-boundaries.md)
- [B3 implementation and verification status](docs/architecture/b3-gate-implementation-status.md)

## Development and verification

Use Node.js 24.x, npm 11.x and Git. npm is the package manager. Exact NestJS, PostgreSQL driver, TypeScript and typing versions are locked.

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

`.env.example` documents anticipated placeholder configuration. D1.1 does not consume it and requires no AWS or OpenAI credentials. Trusted tenant identity must later be established server-side.

Initial D1.1 verification reported Docker unavailable. Subsequent acceptance review distinguished sandbox access denial from daemon state and observed server version 28.5.1 through an approved read-only query outside the sandbox. These are historical observations, not guarantees of current access. PostgreSQL runtime readiness remains unresolved. PostgreSQL's client, Rust/Cargo and LocalStack tooling were missing. These do not block harness verification. Database and container work require separate D1.2 authorization and runtime verification. See [observed D1.1 evidence](docs/verification/D1.1.md).

## D1.2 local setup and verification

D1.2 subsequently verified PostgreSQL 17.12 and real HTTP catalog reads; the preceding paragraph preserves the D1.1 observation. This is a local portfolio simulation with fictional inventory and prices, not provider catalog data or a deployed service. Demo credentials are not production identity management. Prerequisites are metadata, not an eligibility decision. The future provider adapter remains an architectural boundary.

Review [config/d1.2.env.example](config/d1.2.env.example). In a private shell environment, supply `P3_DB_PASSWORD`, `DATABASE_URL`, `P3_DEMO_TOKEN_A` and `P3_DEMO_TOKEN_B`; never put real values in tracked files or command arguments. Use two distinct random URL-safe tokens of 32–256 characters. The database URL must identify local user/database `p3_d12`; the test additionally requires `127.0.0.1:55432`. Keep the database password consistent with the URL and retain it privately to reuse the volume. Do not use `docker compose config` to print resolved secrets.

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

Ctrl-C stops the foreground API. `docker compose stop postgres` stops only this project's database without deleting its persistent volume; do not remove volumes as routine cleanup. Host-context permission may be required where the sandbox blocks Docker or localhost networking. The executed session's private generated configuration location and retained runtime state are documented in the D1.2 record without exposing values.

## Review and future publication

Future GitHub publication is mandatory for portfolio completion but is not authorized by D1.1. After separate authorization: review the full file set, audit secrets, stage approved files, create a meaningful commit, configure the approved repository remote, push without force, independently verify the remote SHA/file set and record evidence. No repository URL is assumed.

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

Run integration suites serially against the already verified dedicated database at `127.0.0.1:55432`, with no active demo. D1.2 tests initialize/check fixtures and temporarily change activity; D1.3 tests are read-only and refuse any deviation from all six expected fixture rows. Both close their owned applications/pools. Do not create/recreate containers or reset fixtures to make verification pass. The current increment authorizes local verification only; staging, commits, pushes and D1.4 require separate authorization.
