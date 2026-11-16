# P3 AI Program Advisor

An independently implemented, Wandari-aligned portfolio simulation of the original **Intelligent Agent for E-commerce** assignment. This is not a claim of customer deployment or verified production work.

## Status and target

Current implementation: **D1.1 development harness only**. No application endpoints, catalog, authentication, pricing, eligibility checks or recommendations exist.

The production-target architecture was designed during Day 0 according to the owner; its architecture artifacts are not present here. The assigned target is a NestJS/TypeScript API, PostgreSQL on RDS, deterministic Rust ranking, OpenAI approved tool calling, and EC2 hosting, with Terraform and bounded LocalStack simulation later. LocalStack must fit the intended long-term Base plan; feature compatibility is currently unknown.

Status words have distinct meanings:

| Term | Meaning and current evidence |
| --- | --- |
| Designed | Target decisions; not proof of executable behavior |
| Implemented | Harness source exists; application is absent |
| Tested | Only the commands and results in the verification record |
| Emulated | No AWS services have been emulated |
| Deployed | Nothing has been deployed |

The seven business invariants and authorization rules are in [AGENTS.md](AGENTS.md). They govern later implementation and are not implemented business behavior today.

## Development and verification

Use Node.js 24.x, npm 11.x and Git. npm is the package manager. Exact TypeScript and Node typing versions are locked; there are no application dependencies.

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

## Review and future publication

Future GitHub publication is mandatory for portfolio completion but is not authorized by D1.1. After separate authorization: review the full file set, audit secrets, stage approved files, create a meaningful commit, configure the approved repository remote, push without force, independently verify the remote SHA/file set and record evidence. No repository URL is assumed.

For session recovery, follow AGENTS.md, inspect Git and the verification record, and obtain the next increment's authorization. Day 1 has a 240-minute ceiling; the original 45-minute harness allocation includes D1.0. Total implementation is limited to 20 hours with a provisional $15 spending ceiling. Record measured work, not inferred time.

**TRAINING WHEELS ON:** guided implementation and Codex explanations. **TRAINING WHEELS OFF:** the engineer independently reviews source, chooses verification, manages risk and owns the change. Generated output does not establish mastery.
