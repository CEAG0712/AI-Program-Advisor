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

## Scope and authorization

The approved target stack is NestJS/TypeScript, PostgreSQL/RDS, Rust ranking, OpenAI approved tool calls, EC2, Terraform and bounded LocalStack simulation compatible with the intended Base plan. Targets are not implemented capabilities. Only the D1.1 harness is implemented; business invariants are documented, not enforced by an application.

Work only within the explicitly authorized increment. D1.1 permits these nine harness files, local Git initialization, minimal npm development dependencies and non-destructive verification. Stop for review after verification. D1.2 and publication require separate authorization. Do not stage, commit, tag, configure remotes, push, deploy, provision, call paid APIs, start services, migrate databases or run Terraform during D1.1. Never discard unexpected user changes or use destructive commands without explicit authorization.

## Inspect, verify and recover

At session start confirm the absolute directory, Git root, branch, HEAD if present, status, remotes and applicable instructions. Inspect unexpected files before proceeding; stop on material baseline discrepancies. Never print secrets or raw credential files.

Read [README.md](README.md) and [D1.1 evidence](docs/verification/D1.1.md), inspect source and pending changes, then identify the latest human authorization. A saved plan does not authorize execution. Recover from observed state rather than assuming previous commands succeeded.

Run the increment's actual verification commands and record exit codes, failures, skipped checks and measured time. Cite inspected source or command evidence for claims; distinguish designed, implemented, tested, emulated and deployed. Stop when verification requires out-of-scope work, credentials, paid operations or unapproved remote changes. Human review owns acceptance; agent output does not establish personal engineering mastery.
