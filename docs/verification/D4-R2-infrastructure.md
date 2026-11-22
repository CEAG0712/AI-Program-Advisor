# D4-R2 offline Terraform foundation

**Disposition** `P3_DAY4_D4_R2_READY_FOR_INDEPENDENT_REVIEW`. Formatting, source inspection, offline provider-schema validation and one mocked topology run with ten assertions are **VERIFIED**. The separately authorized LocalStack lifecycle covered the VPC and application subnet. Real AWS deployment remains unverified. [LocalStack verification](D4-localstack.md)

## Business objective and baseline

Maria's recommendation workflow already uses a local synthetic PostgreSQL catalog. The proposed AWS foundation gives an operator a way to demonstrate that workflow from one EC2 instance and a private Single-AZ RDS PostgreSQL instance. The local application and its policy still derive tenant authority on the server, read catalog facts by tenant, enforce prerequisites, allow a safe no-match result and confer no checkout authority. The future provider catalog adapter remains an explicit boundary. [Operating contract](../../AGENTS.md) · [AWS and Terraform decisions](../architecture/decisions.md#adr-007--aws-ec2rds-deployment-target)

**VERIFIED baseline** The Git root matched the intended checkout. Branch `main`, `HEAD` and the local tracking ref `origin/main` matched `f0dec80a0513c386e57c7ef199e1b0119aee9f43`. The existing fetch and push URLs were `https://github.com/CEAG0712/AI-Program-Advisor`. The worktree and index were clean before editing. The resumed authorization supplied the full implementation specification. D4-R1 was used as historical context.

## Initial D4-R2 changed-file inventory

The initial D4-R2 increment added these eight paths.

| Path | Content |
| --- | --- |
| `infra/aws/versions.tf` | Terraform and AWS provider constraints and region selection |
| `infra/aws/variables.tf` | Required, validated inputs |
| `infra/aws/network.tf` | VPC, subnets, routes and security groups |
| `infra/aws/compute.tf` | EC2, IAM role and instance profile, agent and secret policies |
| `infra/aws/database.tf` | Private Single-AZ PostgreSQL and subnet group |
| `infra/aws/outputs.tf` | VPC ID, instance ID, private DB hostname and PostgreSQL port |
| `infra/aws/tests/topology.tftest.hcl` | One mocked plan run with ten assertions |
| `docs/verification/D4-R2-infrastructure.md` | Decisions and verification evidence |

The initial increment omitted `infra/aws/.terraform.lock.hcl` while provider verification was pending. The follow-up generated a Linux ARM64 lockfile in the isolated workspace for that run.

## ENGINEERGAME v7.0 handoff

| Exact source and configuration | First-person business reasoning |
| --- | --- |
| **Inputs and provider** · `required_version = "~> 1.11.0"`, AWS `version = "~> 5.100.0"`, `region = var.aws_region`. `aws_vpc.advisor` uses two preconditions for subnet containment and overlap. [Versions](../../infra/aws/versions.tf#L1) · [Inputs](../../infra/aws/variables.tf#L1) · [Preconditions](../../infra/aws/network.tf#L13) | I receive a region, three zone selections, four canonical IPv4 CIDRs, an AMI, sizes and exact secret references. I selected the installed Terraform 1.11 minor line for the mock test design and the AWS provider 5.100 patch line as the schema target. This bounds version selection while leaving package integrity and provider compatibility for an offline check with a verified mirror. Input validation can reject malformed values, overlapping subnets and matching DB zones. AWS inventory would still need to confirm that the chosen zones, AMI architecture, instance types and PostgreSQL version are available together. |
| **Network and routing** · `aws_vpc.advisor`, `aws_subnet.application`, `aws_subnet.database`, `aws_internet_gateway.application`, `aws_route_table.application` with `0.0.0.0/0`, and `aws_route_table.database` with `route = []`. Both DB subnets have explicit DB table associations. [Subnet and route definitions](../../infra/aws/network.tf#L47) | I give the operator's host one path for outbound agent traffic and keep the catalog subnets on their own route table with only VPC-local routing in this design. Two DB subnets in different zones let me define the subnet group while keeping the database Single-AZ. An app routing or DNS error can break agent registration. Source and the mock design check what Terraform declares. Network reachability and isolation need later evidence. |
| **Traffic policy** · `aws_security_group.application.ingress = []`. Its egress allows TCP 443 to IPv4 destinations and TCP 5432 to the two DB CIDRs. `aws_security_group.database` permits only TCP 5432 from `aws_security_group.application.id` and declares empty egress. [Security groups](../../infra/aws/network.tf#L106) · [Firewall assertions](../../infra/aws/tests/topology.tftest.hcl#L83) | I keep SSH and the API listener out of the inbound path. I let the app reach PostgreSQL and the agent reach HTTPS endpoints. Security-group statefulness permits replies to allowed connections. The public HTTPS destination range can also reach other IPv4 services. A compromised instance could use that path, so I would revisit destination restrictions if the demo handles real data. The DB rule identifies the host security group. Tenant policy still comes from the authenticated backend and scoped SQL. |
| **EC2 and operator access** · `aws_instance.application` consumes the explicit AMI and instance type, selects the app subnet and SG, and uses `associate_public_ip_address = true`, `http_tokens = "required"`, hop limit 1 and an encrypted root device. There is no `user_data`. [Instance](../../infra/aws/compute.tf#L64) · [Loopback listener](../../src/main.ts#L7) | Maria previously reached the synthetic API on loopback. I preserve that listener design and plan for an authorized operator to forward a port through Session Manager. The public IPv4 gives the approved outbound route a path without a NAT gateway. A missing or incompatible agent, bad operator permissions or a host failure would block the session. I need an approved AMI, a compatible operator client, restricted operator permissions and a separately verified session before a demo. |
| **Instance IAM** · `aws_iam_role.application` trusts `ec2.amazonaws.com`. `aws_iam_instance_profile.application` binds the role to EC2. `aws_iam_role_policy.session_manager` lists only instance registration and four message-channel actions. The `Resource = "*"` is in the agent policy. [Role and agent policy](../../infra/aws/compute.tf#L1) · [Profile](../../infra/aws/compute.tf#L59) | I use temporary role credentials for the host so the walkthrough can avoid distributed AWS keys. I limit the agent actions and leave caller-side `StartSession` authorization to a separate operator identity. If registration or channel creation fails, the operator has no inbound fallback in this topology. The next access review should check principal and session-document restrictions, port forwarding scope and IAM propagation. |
| **Secrets Manager** · `aws_iam_role_policy.application_secrets` allows only `secretsmanager:GetSecretValue` on `sort(tolist(var.application_secret_arns))`. `deny_database_master_secret` denies the same action on `aws_db_instance.catalog.master_user_secret[0].secret_arn`. The input regex requires full suffixed ARNs and disallows wildcards. [Secret policies](../../infra/aws/compute.tf#L33) · [Input validation](../../infra/aws/variables.tf#L127) | I receive only references for approved runtime credentials. I keep the database administrator credential away from the application role with an explicit deny. That also makes host creation depend on the DB publishing its managed secret ARN. A wrong ARN or a secret-key policy can still prevent the application from obtaining credentials. Runtime secret population, customer-managed KMS access if needed, rotation and pool reload require separate work and evidence. |
| **RDS and application compatibility** · `aws_db_instance.catalog` uses `engine = "postgres"`, `publicly_accessible = false`, `multi_az = false`, `storage_encrypted = true`, `manage_master_user_password = true`, `storage_type = "gp3"` and `port = 5432`. It uses the two DB subnets and only the DB SG. The existing config permits loopback PostgreSQL and the pool configures `ssl: false`. [RDS](../../infra/aws/database.tf#L1) · [Local configuration](../../src/config.ts#L16) · [Pool](../../src/app.module.ts#L90) | I keep PostgreSQL as the source of synthetic offers, prices and prerequisites. Private reachability, encryption at rest and a managed admin password are declared. The current app still needs separately approved RDS configuration with hostname and certificate verification, a least-privilege DB role, schema and fixture administration. I need an approved server TLS policy and a connection test. This foundation establishes neither tenant isolation in PostgreSQL itself nor a working application-to-RDS connection. |
| **Recovery** · `backup_retention_period = 7`, `deletion_protection = true`, `skip_final_snapshot = false`, `final_snapshot_identifier = "${var.name_prefix}-catalog-final"`. EC2 and RDS each have one instance. [RDS settings](../../infra/aws/database.tf#L23) | I protect Maria's synthetic catalog against some operator mistakes and specify retention and final snapshot intent. A final snapshot name collision could block deletion. A host or AZ outage can interrupt the demo until replacement or restoration. I would restore to a separate private endpoint, verify the schema, counts, tenant ownership and offer facts, then cut over and retest. Restore durability, failover, regional loss and RTO/RPO remain unverified or unresolved. |
| **State and output boundary** · `versions.tf` declares no backend. `outputs.tf` exposes only `vpc_id`, `application_instance_id`, `database_address` and `database_port`. The IAM policy uses a master secret ARN, and RDS receives no password input. [Root configuration](../../infra/aws/versions.tf#L1) · [Outputs](../../infra/aws/outputs.tf#L1) | I expose identifiers an operator needs for a future session and connection setup. I keep secret values out of the configuration and outputs. Future state or plan files can still reveal topology and secret ARN metadata. A shared workflow needs separately authorized remote storage, encryption, versioning, locking and narrowly scoped access. The offline run generated no state or plan artifacts. |
| **Verification** · `mock_provider "aws"`, plan-time fixture overrides and `run "demo_topology" { command = plan }`. Assertions cover app rules and attachment, IMDSv2, DB exposure and ingress, subnet placement and route separation, backups, exact secret permissions and the admin secret deny. [Mock suite](../../infra/aws/tests/topology.tftest.hcl#L1) | I use synthetic IDs and secret references so a reviewer can evaluate intended wiring without AWS calls. Formatting passed and I traced source references. An authenticated offline provider package is the next dependency for schema validation and mock execution. A passing mocked plan would still leave live IAM, network behavior, availability and restoration unverified. |
| **Cost and alternatives** · One EC2 instance with public IPv4 and one Single-AZ RDS instance with gp3, plus the managed master secret and backup policy. The root defines no load balancer, NAT gateway, VPC endpoints or Multi-AZ database. [Compute](../../infra/aws/compute.tf#L64) · [Routing](../../infra/aws/network.tf#L70) · [Database](../../infra/aws/database.tf#L8) | I fit an operator-led walkthrough into a small topology. Future spend includes instance runtime, public IPv4, EBS, RDS storage, backups, Secrets Manager and data transfer. A public HTTPS ALB gives users a different access path and adds frontend infrastructure and running charges. Private EC2 with interface endpoints reduces internet exposure and adds endpoint costs. Multi-AZ RDS addresses a different availability target at higher cost. I need a priced usage window, an availability decision and a teardown owner before provisioning. This increment incurred $0 in cloud or license charges. |
| **Observability and Staff Engineer review** · `GET /health` is a process probe. The database access path, operator tunnel and managed role are declarations in this root. [Health controller](../../src/health.controller.ts#L1) · [Route and SG configuration](../../infra/aws/network.tf#L76) | I would use a scoped synthetic catalog request alongside process health because the API can be alive while the catalog is unavailable. I still need to define safe access auditing, log sinks and retention, and test the SSM session and recovery behavior. In review I would defend the public IPv4 trade-off, the explicit DBA credential separation and the Single-AZ outage risks against Maria's operator-led needs. I would also ask which actor owns restore approval, credential rotation and incident response before any live run. |

## Initial offline verification

| Command or inspection | Exit and observed result |
| --- | --- |
| `pwd -P`, `git rev-parse --show-toplevel`, `git branch --show-current`, `git rev-parse HEAD origin/main`, `git status --short --branch --untracked-files=all`, `git remote -v` | `0` each. Verified the directory, expected refs, remote and clean initial checkout. |
| `command -v terraform` | `0`. Resolved to `/opt/homebrew/bin/terraform`. D4-R1 recorded version 1.11.2 on this environment. |
| `/usr/bin/env -i PATH=/opt/homebrew/bin:/usr/bin:/bin CHECKPOINT_DISABLE=1 /opt/homebrew/bin/terraform fmt -recursive infra/aws` | `0`. Normalized test-file spacing on the first pass. |
| `/usr/bin/env -i PATH=/opt/homebrew/bin:/usr/bin:/bin CHECKPOINT_DISABLE=1 /opt/homebrew/bin/terraform fmt -check -recursive infra/aws` | `0`. Formatting and parsing passed for the Terraform and test files. |
| `git diff --check`, `git diff --exit-code -- src tests rust db`, `git diff --cached --exit-code` | `0` each. No diff errors, tracked application changes or staged changes. |
| `git --no-optional-locks status --short --untracked-files=all` | `0`. Exactly the eight new allowlisted files. |
| `git diff --no-index --check -- /dev/null <path>` on each new path | `1` per path, with no diagnostics. This no-index form reports a difference from the empty input. It included the untracked files in the whitespace check. |
| `test ! -e infra/aws/.terraform.lock.hcl` and `test ! -e infra/aws/.terraform` | `0` each. No provider lockfile or working data directory generated. |
| `rg -n '^(resource\|variable\|output\|mock_provider\|override_resource\|run) \|^  assert \{\|^    error_message' infra/aws` | `0`. Enumerated configuration and test declarations for source review. |

The first batch untracked whitespace check used zsh's special `path` variable as the loop variable and each Git invocation exited `127`. The corrected batch used `added_file` and produced the eight diagnostic-free results above.

The static command below exited `0`. It checks initialization scope, the mock shape and selected credential-field patterns. Source review covered the network and policy semantics.

```sh
python3 - <<'PY'
import re
from pathlib import Path
root = Path('infra/aws')
production = '\n'.join(p.read_text() for p in sorted(root.glob('*.tf')))
test = (root / 'tests/topology.tftest.hcl').read_text()
assert not re.search(r'^\s*(?:data\s+"aws_secretsmanager_|resource\s+"aws_secretsmanager_|(?:password|master_password|user_data(?:_base64)?|access_key|secret_key|token)\s*=|backend\s+")', production, re.M)
assert re.findall(r'^output "([^"]+)"', production, re.M) == ['vpc_id', 'application_instance_id', 'database_address', 'database_port']
assert len(re.findall(r'^  assert \{', test, re.M)) == 10
assert re.findall(r'^\s*command\s*=\s*(\w+)', test, re.M) == ['plan']
assert re.findall(r'^mock_provider "([^"]+)"', test, re.M) == ['aws']
print('Static scope, credential-field, output and mock structure checks passed.')
PY
```

**VERIFIED static security inspection** The app has no inbound rule, the DB group has a single app-group ingress source for PostgreSQL, and both DB subnets associate with the table that has no explicit routes. The agent policy is action-scoped. Secret reads are restricted to exact configured ARNs, with an explicit denial for the RDS managed master secret. Inspected outputs contain identifiers and connection metadata. Source inspection found no literal credential values, Secrets Manager value resources or data sources, static AWS credentials, or EC2 user data. The test uses fabricated IDs and ARNs. Static inspection covers reviewed source intent.

**BLOCKED provider-dependent verification** The preceding D4-R2 read-only inventory found zero AWS provider binaries or archives in six checked locations, including the project provider directory and standard local cache/plugin paths. A previously approved, independently verified offline mirror remained unavailable. `terraform init -backend=false`, `terraform validate` and `terraform test -filter=tests/topology.tftest.hcl` were **NOT RUN** and have no exit codes. One mock test run with ten assertions was authored. Results were zero passed, zero failed and one run skipped externally because it was never invoked. The provider schema, mock override interpretation and validation expressions were not executed.

**DEFERRED checks and spending** Application tests, live planning, deployment, RDS TLS and SQL, AWS IAM behavior, operator access, observability and restore checks are outside the offline foundation. No provider downloads, paid operations, AWS credentials, service starts, migrations or publication occurred. Cloud and license spend was **$0**.

**Timing** The first D4-R2 attempt ran from 10:10:35 to 10:12:41 on November 22, 2026, Panama time. The resumed turn began at 10:15:12. At the 10:21:13 verification checkpoint the two active windows totaled approximately 8 minutes 7 seconds, excluding the interval awaiting the specification. Final evidence edits and Git checks followed within the 90-minute ceiling.

## Retained offline follow-up

The owner-authorized follow-up used Terraform 1.11.2 on Linux ARM64 and AWS provider 5.100.0 from a filesystem mirror. The signed checksum manifest verified against the asserted HashiCorp fingerprint, and the archive matched both the signed checksum and the recorded registry digest. Terraform reported the mirror installation as unauthenticated, so the evidence for package integrity comes from the independent checks. The source and test checksums still match the follow-up manifest.

| Retained check | Result |
| --- | --- |
| `terraform init -backend=false -input=false -lockfile=readonly -no-color` | Exit 0. Installed AWS provider 5.100.0 from the offline mirror. |
| `terraform validate -no-color` | Exit 0. Configuration valid. |
| `terraform test -no-color -filter=tests/topology.tftest.hcl` | Exit 0. One mocked plan run passed, with ten assertions and zero failures. |

The bounded LocalStack Community exercise superseded the earlier Ultimate proposal for this checkpoint and used separate owner authorization. Session Manager port forwarding, EC2 instance runtime, RDS, live IAM behavior, actual AWS networking and production readiness remain unverified. [LocalStack scope and results](D4-localstack.md)
