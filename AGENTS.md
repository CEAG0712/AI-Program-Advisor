# P3 operating contract

Build P3 AI Program Advisor, an independent Wandari-aligned portfolio simulation of the original Intelligent Agent for E-commerce assignment. Do not imply customer deployment or verified production work.

## Business invariants

1. Never invent course offers or authoritative prices.
2. Never accept a model-provided tenant ID as authorization.
3. Never expose cross-tenant catalog data.
4. Never waive prerequisites or silently treat unknown eligibility as valid.
5. Never interpret a model recommendation as checkout authorization.
6. No suitable offer is a valid and safe response.
7. Preserve an explicit future catalog integration boundary.

## Implementation status

D1.1 added the engineering harness. D1.2 added the local NestJS/PostgreSQL synthetic catalog with demo authentication and tenant-scoped reads. D1.3 added the authenticated deterministic recommendation endpoint with runtime validation, bounded candidate reads, budget and study-hour filtering, and exact declared-skill checks. The policy establishes synthetic suitability. Admission verification and checkout remain outside the implementation. [D1.1 evidence](docs/verification/D1.1.md) · [D1.2 evidence](docs/verification/D1.2.md) · [D1.3 evidence](docs/verification/D1.3.md)

Day 2 implemented the advisor's validated `find_suitable_courses` tool path, grounded responses, a fake model, and an explicitly enabled OpenAI Responses application programming interface (API) adapter. Day 2 retains separate evidence for controlled live tests. [Day 2 checkpoint](docs/architecture/b3-gate-implementation-status.md)

Day 3 completed independent review of the D3-R1 standalone Rust ranker, D3-R2 opt-in Node.js integration, the accepted advisor Unicode correction, and the documentation. Normal startup uses TypeScript ranking. Day 3 verified the Rust integration locally with fake PostgreSQL and model dependencies. Day 3 publication received separate owner authorization. [Day 3 evidence](docs/verification/D3-rust-ranking.md)

Provider catalog ingestion remains future work. The cloud target includes Amazon Elastic Compute Cloud (EC2), Amazon Relational Database Service (RDS), Terraform, and bounded LocalStack simulation. Deployment and LocalStack Base compatibility remain unverified.

## Scope and authorization

The Day 3 documentation authorization covered only `README.md`, `AGENTS.md`, and `docs/verification/D3-rust-ranking.md`, plus bounded local documentation checks. It required preserving the reviewed source and tests and excluded engineering changes, dependency installation, staging, commits, tags, remote changes, pushes, publication, deployment, paid API calls, and D3-R3. The owner separately authorized the exact 18-file publication, narrow status edits, four linear commits, and one normal fast-forward push. These historical permissions confer no authority for future work.

Historical permissions were limited to their respective increments. D1.1 authorized nine harness files, local Git initialization, minimal npm development dependencies, and non-destructive verification. D1.2 required separate approval. D1.3 authorized its allowlisted source changes and bounded verification against the existing isolated PostgreSQL instance. That approval excluded dependency changes, staging, commits, pushes, and D1.4. Each increment stopped for review after verification. These records describe past scope and confer no new authorization.

Obtain explicit owner authorization before starting each implementation increment or staging, committing, tagging, configuring remotes, pushing, publishing, deploying, provisioning, calling paid APIs, starting services, migrating databases, or running Terraform. Never discard unexpected user changes or use destructive commands without explicit authorization.

## Inspect, verify and recover

At session start confirm the absolute directory, Git root, branch, HEAD if present, status, remotes and applicable instructions. Inspect unexpected files before proceeding; stop on material baseline discrepancies. Never print secrets or raw credential files.

Read [README.md](README.md) and [D1.1 evidence](docs/verification/D1.1.md), inspect source and pending changes, then identify the latest human authorization. A saved plan does not authorize execution. Recover from observed state rather than assuming previous commands succeeded.

Run the increment's actual verification commands and record exit codes, failures, skipped checks and measured time. Cite inspected source or command evidence for claims; distinguish designed, implemented, tested, emulated and deployed. Stop when verification requires out-of-scope work, credentials, paid operations or unapproved remote changes. Human review owns acceptance; agent output does not establish personal engineering mastery.
