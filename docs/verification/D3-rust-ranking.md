# Day 3 Rust ranking verification

Day 3 adds an opt-in Rust ranking path to the P3 AI Program Advisor portfolio simulation. The business requirement is to preserve tenant isolation, catalog facts, suitability rules, and ranking order when swapping the ranking implementation. The acceptance criteria include parity with TypeScript, deterministic tie-breaking, bounded process use, and explicit failure handling. A successful catalog read with no suitable offers can legitimately return an empty list. An adapter error returns a sanitized unavailable outcome. Recommendations express synthetic suitability from declared skills and confer no verified admission or checkout authority. [Operating contract](../../AGENTS.md)

## D3-R1 standalone protocol

The Rust executable reads one bounded JavaScript Object Notation (JSON) request from standard input and writes a single newline-terminated JSON result to standard output on success. The caller closes standard input to signal the end of the request. The request fields are `protocol_version` and `offers`. Version 1 offers contain only `offer_id`, `price_cents`, and `weekly_study_hours`. A response contains `protocol_version` and `ordered_offer_ids`.

- The executable accepts up to 1,000 offers and 1 MiB of input, including whitespace. It rejects malformed or unsupported requests, unknown or duplicate fields, duplicate IDs, IDs outside 1–80 Unicode code points, negative or out-of-range signed 32-bit prices, and study hours outside 1–168.
- Ranking orders study hours descending, price cents ascending, and IDs ascending by UTF-16 code unit, matching the JavaScript comparator without normalization. The result contains at most ten IDs.
- The executable serializes the response into a fixed 10 KiB buffer before writing it. Failures produce a nonzero exit and a fixed diagnostic on standard error. [Rust implementation](../../rust/ranker/src/main.rs) · [Protocol tests](../../rust/ranker/tests/protocol.rs)

## D3-R2 responsibility boundary

Normal startup uses TypeScript ranking. Server-owned application composition can supply `rustRankerPath` with an absolute path to an operator-trusted executable. The application disables the shell, supplies no command arguments, and passes an empty environment option. The request body, headers, query, and model tool arguments cannot choose the path or mode. [Application composition](../../src/app.module.ts) · [Normal entry point](../../src/main.ts) · [Adapter](../../src/recommendations/rust-ranker.ts)

The authenticated tenant determines the active catalog scope. The repository reads at most 1,001 rows, using the extra row to detect overflow beyond 1,000 candidates. TypeScript retains the U.S. dollar (USD) currency check and filters by budget, weekly hours, and exact prerequisites. The Rust path validates the catalog records and sends only already-suitable IDs, cents, and weekly study hours. No tenant identifiers or credentials are included in the protocol payload. A valid empty suitable set bypasses the subprocess. [Scoped catalog repository](../../src/catalog/catalog.repository.ts) · [Ranking policy](../../src/recommendations/recommendations.policy.ts) · [Recommendation service](../../src/recommendations/recommendations.service.ts)

The adapter requires a successful child exit and one well-formed UTF-8 JSON response with the expected version and fields. Its IDs must match the TypeScript top ten exactly, including count and order. The parity check also rejects duplicate, missing, or unknown IDs. TypeScript reconstructs the response from the original authorized records and fixed reasons. Both recommendation routes return a sanitized Hypertext Transfer Protocol (HTTP) 503 response when ranking fails. [Adapter validation](../../src/recommendations/rust-ranker.ts) · [Recommendation service](../../src/recommendations/recommendations.service.ts) · [Advisor error mapping](../../src/ai/advisor.controller.ts)

### Process lifecycle

Each application allows two active ranking children. A third request is refused immediately. Requests have no queue or automatic retries. The configured subprocess deadline is 500 ms. Limits are 1 MiB for input, 10 KiB for standard output, and 4 KiB for standard error. The adapter closes standard input after sending the request. It discards diagnostic content and enforces the byte ceiling.

Timeout, cancellation, and shutdown terminate affected children. On close, the adapter clears the timer and cancellation listener and releases capacity. Shutdown refuses new work and waits for the active children to settle. The advisor propagates cancellation into ranking. A PostgreSQL query already in progress may continue, and the service checks cancellation again before spawning. The direct recommendation route relies on the subprocess deadline and app shutdown for cleanup. [Process lifecycle](../../src/recommendations/rust-ranker.ts) · [Advisor executor](../../src/ai/advisor.executor.ts) · [Lifecycle tests](../../tests/rust-ranking.unit.test.ts)

## Unicode compatibility correction

The PostgreSQL catalog and Rust ranker limit IDs to 80 Unicode code points. JavaScript string length counts UTF-16 code units. Under the former advisor limit of 128 code units, a valid 80-code-point ID composed entirely of supplementary-plane characters occupied 160 code units and failed the advisor fact check.

The advisor now uses the same text check as the TypeScript Rust integration and counts code points. It rejects non-string and empty IDs, unpaired surrogates, embedded null characters (U+0000), more than 80 code points, and duplicates. It preserves the original spelling and ordering. Existing suitability checks, byte limits, and grounding checks remain in force. The PostgreSQL-backed path excludes null characters at the catalog boundary. The standalone ranker validates JSON strings and scalar counts. [Catalog schema](../../db/schema.sql) · [Shared text validation](../../src/recommendations/ranking.ts) · [Advisor fact validation](../../src/ai/advisor.service.ts) · [Grounding policy](../../src/ai/response.policy.ts)

The before-fix composed test observed HTTP 200 from `/recommendations` and HTTP 503 from `/advisor/recommendations` for the same 80-supplementary-code-point ID. After the fix, both returned HTTP 200 with the original ID, price, and course facts. The test used the real Rust executable and fake database and model dependencies. It also inspected the actual JSON written to the child. Unit cases covered ASCII and mixed Unicode boundaries, malformed inputs, and a complete model plan with an invented or altered ID producing the existing grounded fallback. [Composed regression](../../tests/advisor.executor.unit.test.ts) · [Advisor regression cases](../../tests/advisor.orchestration.unit.test.ts)

## Retained verification

The commands and outcomes here come from the Day 3 implementation sessions. Documentation alignment reused that evidence. The retained environment was macOS arm64 with Node.js v24.22.0 and Rust and Cargo 1.100.0 for the standalone toolchain check. In the commands below, `$RANKER_TARGET` stands for the original temporary Cargo target directory. Private log redirections are omitted. The command blocks are historical evidence. [Proposed clean-machine recipe](../../README.md#proposed-day-3-reproduction)

### Standalone ranker and initial integration

The D3-R1 formatting pass, format check, locked offline development build, and locked offline tests each exited 0. The tests passed 1 unit test and 19 protocol tests.

~~~sh
cargo fmt --manifest-path rust/ranker/Cargo.toml
cargo fmt --manifest-path rust/ranker/Cargo.toml -- --check
/usr/bin/time -p cargo build --locked --offline --manifest-path rust/ranker/Cargo.toml
/usr/bin/time -p cargo test --locked --offline --manifest-path rust/ranker/Cargo.toml
~~~

At the D3-R2 checkpoint, the locked offline release build, format check, Rust tests, and TypeScript typecheck and build each exited 0. The offline Node.js suite passed 268 tests with zero failures or skips. Earlier fixture runs exited 1 on assertions concerning advisor metadata, JSON property order, and an operating-system-added environment variable. The retained final runs used corrected fixtures. The optional Clippy command exited 1 before linting because the component was unavailable for the selected stable arm64 macOS toolchain. It was left uninstalled.

~~~sh
CARGO_TARGET_DIR="$RANKER_TARGET" "$HOME/.cargo/bin/cargo" build --manifest-path rust/ranker/Cargo.toml --offline --locked --release
"$HOME/.cargo/bin/cargo" fmt --manifest-path rust/ranker/Cargo.toml --check
CARGO_TARGET_DIR="$RANKER_TARGET" "$HOME/.cargo/bin/cargo" test --manifest-path rust/ranker/Cargo.toml --offline --locked
CARGO_TARGET_DIR="$RANKER_TARGET" "$HOME/.cargo/bin/cargo" clippy --manifest-path rust/ranker/Cargo.toml --offline --locked --all-targets -- -D warnings
NODE_DISABLE_COMPILE_CACHE=1 node node_modules/typescript/bin/tsc --noEmit --incremental false
NODE_DISABLE_COMPILE_CACHE=1 node node_modules/typescript/bin/tsc --noEmit false --outDir dist/b3c2-d3r2-6XBe9a --incremental false
NODE_DISABLE_COMPILE_CACHE=1 P3_D3_R2_RANKER="$RANKER_TARGET/release/p3-ranker" \
  P3_B3C2_TEST_BUILD=dist/b3c2-d3r2-6XBe9a node --test --test-concurrency=1 --test-reporter=spec \
  dist/b3c2-d3r2-6XBe9a/tests/*.unit.test.js tests/b3c2-runner.offline.test.mjs
~~~

### Unicode reproduction and final results

| Retained check | Exit | Observed result |
| --- | ---: | --- |
| First focused build | 2 | A test imported a nonexistent Node.js type. The import was corrected before running the reproduction. |
| Focused Node.js run before the advisor fix | 1 | 97 tests total, 89 passed, 8 failed, 0 skipped. Failures included the composed advisor response and Unicode fact cases. |
| Final TypeScript typecheck and build | 0 each | Both succeeded. |
| Final offline Node.js suite | 0 | 279 passed, 0 failed, 0 skipped in 5.003 seconds. |
| Rust format check and locked offline tests | 0 each | Format check passed. The tests passed 1 unit test and 19 protocol tests, with zero failures or ignored tests. |

The focused and final runs used the same release executable built at the D3-R2 checkpoint. The format and Rust test commands above were run again during the correction. The release build and Clippy were not rerun for the correction.

~~~sh
NODE_DISABLE_COMPILE_CACHE=1 node node_modules/typescript/bin/tsc --noEmit false --outDir dist/b3c2-d3r2-unicode-vNMHHG --incremental false
NODE_DISABLE_COMPILE_CACHE=1 P3_D3_R2_RANKER="$RANKER_TARGET/release/p3-ranker" \
  node --test --test-concurrency=1 --test-reporter=spec \
  dist/b3c2-d3r2-unicode-vNMHHG/tests/advisor.orchestration.unit.test.js \
  dist/b3c2-d3r2-unicode-vNMHHG/tests/advisor.executor.unit.test.js
NODE_DISABLE_COMPILE_CACHE=1 node node_modules/typescript/bin/tsc --noEmit --incremental false
NODE_DISABLE_COMPILE_CACHE=1 P3_D3_R2_RANKER="$RANKER_TARGET/release/p3-ranker" \
  P3_B3C2_TEST_BUILD=dist/b3c2-d3r2-unicode-vNMHHG node --test --test-concurrency=1 --test-reporter=spec \
  dist/b3c2-d3r2-unicode-vNMHHG/tests/*.unit.test.js tests/b3c2-runner.offline.test.mjs
~~~

## Benchmark

The final offline suite measured 25 serial pairs per fixture with Node.js's monotonic performance clock. Each pair measured the TypeScript reference sort and top-ten selection first, then awaited a fresh Rust process through the full adapter. The test checked parity for every pair. The seven-candidate fixture exercised numerical boundaries and Unicode tie-breaking. The 1,000-candidate fixture used distinct 80-code-point IDs with characters that require escaping in JSON. [Benchmark test](../../tests/rust-ranking.unit.test.ts)

| Candidates | Pairs | TypeScript median | Full Rust adapter median |
| ---: | ---: | ---: | ---: |
| 7 | 25 | 0.005 ms | 2.881 ms |
| 1,000 | 25 | 0.024 ms | 4.645 ms |

The full adapter time includes candidate validation, serialization, the reference sort, process launch and close, response parsing, and parity checks. TypeScript was faster in both tested workloads and remains the default. Raw sample times were not retained. The benchmark excludes database, HTTP, and model time and does not establish production latency or throughput.

## Limitations

- Day 3 verified local behavior with fake PostgreSQL and model dependencies. Controlled live PostgreSQL and OpenAI checks belong to earlier increments. No Day 3 evidence establishes clean-machine portability, production deployment, customer usage, or a service-level objective. [Earlier advisor evidence](../../README.md#advisor-implementation-and-evidence)
- The 500 ms setting applies to the subprocess. Event-loop scheduling or operating-system cleanup can delay the unavailable response. The executable runs with the application's operating-system permissions, and the adapter manages the direct child. Binary provenance verification and hostile executable containment remain outside this increment.
- The retained environment was macOS arm64. Other platforms remain unverified. Some process fixtures use Unix-style executable scripts, so native Windows test execution remains a portability risk.

## Security and publication

The read-only publication audit matched the reviewed source snapshots and Unicode patch byte-for-byte across the 15 implementation files. The audit checked the server-owned executable selection, protocol projection, candidate file types, and applicable ignore rules. It found synthetic connection and bearer fixtures and no apparent live secrets, private configuration, committed machine-specific paths, or generated artifacts in the candidate. The only new dependency files were the reviewed Rust manifest and lockfile. The audit covered the Day 3 candidate and the retained evidence.

At the November 20, 2026 pre-publication checkpoint, `main` was at `adbd84b94397a212aa003060a4f00225246e4f7e`, with `origin` configured for `CEAG0712/AI-Program-Advisor`. The 15 implementation files were unpublished working-tree changes at that checkpoint. The Day 3 implementation, Unicode correction, and documentation completed independent review. The owner separately authorized the reviewed four-commit publication. Staging, commits, and publication require explicit owner authorization. [Operating scope](../../AGENTS.md#scope-and-authorization)
