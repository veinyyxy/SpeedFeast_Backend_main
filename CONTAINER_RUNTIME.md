# SpeedFeast container runtime contract

The application image is the same artifact in AWS Sandbox and production. A
deployment promotes an immutable ECR digest; it does not rebuild source code or
bake tenant configuration into the image. Sandbox and production differ only
in runtime configuration, secrets, resource sizing, and routing.

## Image invariants

- Build and dependency stages are pinned to the official Node.js
  `24.18.0-bookworm-slim` multi-platform digest. The exact Node binary is copied
  into a pinned `distroless/cc-debian12:nonroot` final stage so build and runtime
  keep the same Debian/glibc ABI.
- The final process runs as the distroless unprivileged uid/gid `65532:65532`.
- The final image has no shell, package manager, npm/Yarn or Perl. Build tools
  and certificate-download tools remain in disposable build stages only.
- The image contains production dependencies and compiled verification assets,
  but no `.env`, test fixtures, database dumps, private keys, or uploaded images.
- `CMD` starts only `node ./bin/www`. Application startup never runs a schema
  migration.
- `APP_IMAGE_REVISION` is the deployed application image digest in the form
  `sha256:<64 lowercase hex characters>`. It is runtime metadata, not the Node
  base-image digest.

Build once and refer to the pushed artifact by digest:

```powershell
docker build --tag speedfeast-backend:s3 .
docker image inspect speedfeast-backend:s3
```

Do not pass secrets as Docker build arguments. In ECS, inject secret values
through the task definition `Secrets` collection using Secrets Manager or SSM
references. Plain settings belong in `Environment`.

## Health contract

| Endpoint | Meaning | External dependency | Consumer |
| --- | --- | --- | --- |
| `GET /health` | Node/Express process is alive | None | Diagnostics and liveness |
| `GET /ready` | API can execute `SELECT 1` | PostgreSQL | Docker, ECS and ALB readiness |

The image health check and target group must use `/ready`. A database outage
therefore removes the task from service instead of advertising a broken API.
The Docker start period is 60 seconds; the ECS task definition may use the same
or a longer value while a new task establishes its database connection.

## Required production environment

The process fails before binding its HTTP port when this contract is invalid.
Values below are names and sources only; no secret value belongs in Git.

| Variable | Source | Requirement |
| --- | --- | --- |
| `NODE_ENV` | task environment | `production` |
| `HOST`, `PORT` | image/task environment | `0.0.0.0`, `3000` |
| `APP_IMAGE_REVISION` | deployment worker | Immutable deployed ECR digest |
| `DATABASE_URL` | Secrets Manager | Tenant database login URL |
| `PGSSLMODE` | image/task environment | `verify-full` |
| `PGSSL_REJECT_UNAUTHORIZED` | image/task environment | `true` |
| `PGSSLROOTCERT` | image | AWS RDS global bundle path |
| `CORS_ALLOWED_ORIGINS` | deployment configuration | Comma-separated HTTPS buyer and merchant origins |
| `HMAC_SECRET_KEY`, `JWT_SECRET_KEY` | Secrets Manager | Unique per tenant |
| `JWT_EXPIRES_IN`, `MERCHANT_JWT_EXPIRES_IN` | deployment configuration | Explicit durations |
| `SAAS_CONTROL_PUBLIC_KEY` | Secrets Manager | Platform control-token verification key |
| `SAAS_JWT_ISSUER` | deployment configuration | HTTPS control-plane issuer |
| `SAAS_INSTANCE_ID` | deployment configuration | Immutable platform app-instance ID |
| `SAAS_JWT_AUDIENCE` | deployment configuration | `speedfeast-instance:<SAAS_INSTANCE_ID>` |
| `SAAS_REQUIRE_INSTANCE_CLAIM` | task environment | `true` |
| `SAAS_REQUIRE_MTLS` | task environment | `true` |
| `SAAS_TRUST_PROXY_MTLS_HEADER` | task environment | `true` only behind the private ALB path |
| `SAAS_MTLS_PROXY_MODE` | task environment | `aws_alb_verify` |
| `PAYMENT_PROVIDER` | deployment configuration | Currently `stripe` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Secrets Manager | Test keys in Sandbox, live keys only in production |
| `STRIPE_PUBLISHABLE_KEY` | deployment configuration | Must match the selected Stripe environment |
| `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` | deployment configuration | HTTPS tenant buyer URLs |
| `IMAGE_STORAGE_PROVIDER` | task environment | `s3` |
| `IMAGE_S3_BUCKET`, `IMAGE_PUBLIC_BASE_URL`, `AWS_REGION` | Cell/deployment configuration | Tenant prefix and HTTPS public base URL |
| `SMS_PROVIDER` | deployment configuration | `demo` in Sandbox; configured provider in production |

The task security group must accept application traffic only from the Cell ALB
security group when proxy mTLS headers are trusted. The public listener must
reject `/api/saas` and `/api/saas/*`; only the separate mTLS listener may route
those paths.

The RDS global CA bundle is part of the immutable image at
`/usr/local/share/ca-certificates/aws-rds-global-bundle.pem`. Both Dockerfiles
verify the AWS download against the reviewed SHA-256
`e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3`
before accepting it. ECS must not inject a SecretString into
`PGSSLROOTCERT`; that variable is a filesystem path supplied by the image.
Changing the AWS bundle requires an explicit hash update and image rebuild.

In production, `DATABASE_URL` cannot weaken the task-level database policy.
`sslmode=disable`, `require`, `verify-ca` and similar values are rejected, as
are URL-level `ssl`, certificate/key, CA-path and libpq-compatibility
overrides. An optional `sslmode=verify-full` is validated and then removed
before node-postgres parses the URL, preserving the CA-backed explicit SSL
object as the final connection configuration.

The URL authority (or `PGHOST` when no URL is used) must contain one fully
qualified DNS hostname. IP literals, Unix sockets, whitespace and comma-separated
host lists are rejected. The only permitted URL query parameter is one optional
`sslmode=verify-full`, which is validated and removed; `host`, `hostaddr`,
`port`, `service`, `options`, alternate TLS server names, unknown parameters and
other target/TLS/authentication overrides are rejected before node-postgres
constructs a client. This prevents a URL query from replacing the hostname
whose identity `verify-full` is expected to verify.

## Database bootstrap and migrations

Database changes are deliberately separate from web-process startup:

1. Create an empty PostgreSQL 16 tenant database and least-privilege login.
2. For the current legacy baseline, run the one-shot image built from
   `Dockerfile.migration`. It accepts an encrypted private-S3 dump plus a
   manifest and SHA-256 values, rejects a non-empty destination, restores in a
   transaction, verifies table row counts, and creates the application role.
3. Run the application image once with command
   `/usr/local/bin/node db/apply_saas_control.js`. This applies
   `db/saas_control.sql` and `db/theme_config.sql` in one transaction; both
   scripts are idempotent. The final image deliberately does not contain npm.
4. Start the ECS service only after both one-shot tasks succeed and `/ready`
   returns HTTP 200.

The restore image and its destination guard are pinned to PostgreSQL 16.14 to
match the current Aurora Sandbox baseline. It must not be used against another
major version.

The migration task also rejects inherited libpq service, target, session-option
and TLS overrides. Every database command explicitly selects the confirmed
host, port, database and administrator with `verify-full` and the immutable
image CA. After connecting it reconciles `current_database`, `current_user`,
`inet_server_addr`, `inet_server_port`, DNS resolution and `pg_stat_ssl` before
inspecting or changing the destination. `APP_DB_USER` must be a new,
non-reserved cluster role; an existing role is a hard failure and is never
adopted or assigned a new password.

### B5-G ARN-native lifecycle contract

The SaaS platform has an offline, SDK-free boundary for injected ECS
`RunTask`, exact `startedBy` recovery, `DescribeTasks`, and `StopTask`. Its
reviewed request contract carries only a generation-bound runtime Secret ARN,
fixed code-owned command, active external-operation epoch, and—where
required—an independently approved baseline digest. The corresponding Secret
must be physically named under `/runtime/gN` and contain exactly
`database_url`, `hmac_secret_key`, `jwt_secret_key`, `stripe_secret_key`, and
`stripe_webhook_secret`.
The `database_url` must name a concrete PostgreSQL database and contain exactly
one `sslmode=verify-full` query parameter; host, TLS and libpq compatibility
overrides are rejected before the lifecycle database provider is called.

This repository now provides the offline ARN-native task entrypoint
`db/tenant_lifecycle.js` and an injected lifecycle service for exactly six
code-owned operations: `inspect`, `prepare_empty_database`,
`restore_approved_baseline`, `migrate_saas`, `verify`, and `destroy`. It accepts
only the Secret ARN, generation/ownership fence, active external epoch, and the
approved baseline digest where required. Direct `DATABASE_URL`, PostgreSQL
password, Stripe/JWT/HMAC values, baseline S3 locations, arbitrary command, and
Secret JSON inputs are rejected. The injected Secret provider must return
exactly the five reviewed keys inside a scoped callback; no Secret value is
written to a task result or error.

The lifecycle service builds and validates a durable marker containing stable
identity, generation, ownership marker, provision epoch/marker/hash, baseline
digest, migration contract, and lifecycle state. A PostgreSQL provider must
persist that marker with database and role ownership metadata, conditionally
match the full prior observation under one database lock, and install the next
marker with the associated action. This contract makes a replay after a lost
task response return `already_applied`, rejects older epochs, rejects
same-epoch marker/hash drift, and refuses foreign identity or generation
adoption.

`destroy` additionally requires the exact immediately preceding provision
epoch, marker, and operation hash. Missing predecessor fields are rejected
before Secret resolution or database inspection. A real provider must compare
those fields with its durable generation record before its first destructive
write and retain only a non-secret tombstone for idempotent retry.

The entrypoint deliberately installs disabled Secret, PostgreSQL, and raw
receipt publishers. The synthetic tests exercise the state machine and receipt
contract without connecting to AWS or a database, but the following production
pieces remain blocked: an AWS SDK Secrets Manager resolver, a PostgreSQL 16
admin/locking implementation, a reviewed empty baseline artifact, a
lifecycle-capable restore image, and platform Worker root wiring. The legacy
`scripts/run-rds-migration.sh` and direct `db/apply_saas_control.js` commands do
not persist this lifecycle marker and must not be treated as the B5-H task
provider. No image was built or deployed, no ECS task ran, no AWS/Neon endpoint
was contacted, and no SQL was applied in B5-H.

The B5-H CLI validates an immutable receipt destination and asks the injected
publisher for the exact existing object before any Secret or database access.
An exact existing envelope returns its frozen operation output immediately. A
disabled/incomplete publisher, S3 permission or timeout error, corrupt object,
or foreign fence therefore fails before lifecycle work; only a strict S3
`NoSuchKey` permits Secret resolution and database access. The destination
requires all three controlled values:

- `TENANT_RECEIPT_BUCKET`, exactly
  `techlong-sandbox-<account>-<region>-tenant-receipts`, derived from the
  generation-bound runtime Secret ARN;
- `TENANT_RECEIPT_EXPECTED_BUCKET_OWNER`, exactly matching the account in the
  generation-bound runtime Secret ARN; and
- `TENANT_RECEIPT_KEY`, exactly
  `tenant-lifecycle/v1/<stable-hash>/g<generation>/<idempotency-sha256>.json`,
  with the stable hash and generation cross-checked against the lifecycle
  ownership marker.

After a successful lifecycle operation, the injected publisher constructs one
canonical UTF-8 JSON line of at most 4096 bytes. Its exact fields are
`schemaVersion`, `operation`, `resourceGeneration`, `ownershipMarker`,
`externalEpoch`, `externalMarker`, `externalOperationHash`, `output`, and
`outputHash`. Operation output has its own strict allowlist, so database URLs,
credentials, and arbitrary provider data cannot enter the object. The raw
envelope deliberately does not claim an ECS task ARN, platform request hash, or
final receipt hash.

The AWS SDK v3 object-store adapter is dependency-injected and checks the S3
client region against the Secret ARN region. It writes with
`ExpectedBucketOwner`, `Content-Type: application/json`, `If-None-Match: *`, a
full-object SHA-256 checksum, and `AES256` server-side encryption. If S3 reports
a precondition failure or the response is lost, it reads the exact key with
checksum mode enabled and accepts the retry only when owner enforcement,
content type, encryption, checksum, and canonical bytes all match. A collision
fails closed. The default CLI wires only the disabled publisher and emits a
fixed status line rather than treating logs as a second receipt channel.

The read-before-work rule also closes the response-loss replay gap. If a write
was never accepted, a later `NoSuchKey` retry may safely execute the idempotent
database transition and publish its `already_applied`/`already_missing` output.
If S3 accepted the original bytes but both responses were lost, the next task
returns the original immutable `applied`/`deleted` output without touching the
Secret or database. It never guesses that two different lifecycle outputs are
equivalent.

The platform must still independently bind this raw envelope to the reviewed
request and exact `DescribeTasks` observation before it constructs
`requestHash`, the final receipt hash, or accepts an ECS task. Until that reader
and production providers are wired and exercised, a real ECS canary remains
prohibited.

### Tenant baseline data policy

Hash verification alone does not make a database export safe for a new
tenant. Before the migration task contacts the destination database, its
manifest must pass all of these checks:

- `purpose` is exactly `tenant_bootstrap`.
- `dataPolicy` is `schema_only`, in which case every table has `rows: 0`; or it
  is `allowlisted_seed_tables` with an explicit `seedTableAllowlist`.
- A manifest allowlist is also restricted by application code. Currently only
  `public.merchant_permissions` and `public.merchant_role_permissions` are
  approved reference-data tables.
- User, customer, store, order, payment, notification, audit, SaaS instance,
  license and other sensitive business tables always have zero rows. They
  cannot be enabled by a manifest-controlled allowlist.
- Every restored table and its final row count must still exactly match the
  accepted manifest.
- The archive SHA-256 must exactly equal both the approved runtime value and
  `archiveSha256` in the separately SHA-256-bound manifest.
- `APPROVED_TENANT_BASELINE_SHA256` is an independent deployment allowlist
  value and must equal `MIGRATION_SHA256` and the downloaded archive digest.
  It must be supplied from a reviewed operator-controlled configuration, not
  copied from the manifest. Manifest/archive self-consistency proves integrity,
  not that an artifact has been approved for tenant bootstrap.
- The downloaded archive is limited to 500 MiB, the manifest to 1 MiB, and the
  restore TOC to 20,000 entries before any target restore is attempted.
- Before connecting to the destination, `pg_restore --list` is parsed with an
  object-type allowlist. Only the public schema, manifest tables, indexes,
  constraints, defaults, sequences, two code-approved helper functions and
  explicitly approved seed `TABLE DATA` entries are accepted. Extensions,
  BLOBs, ACLs, security labels, event triggers, foreign objects, arbitrary
  functions, triggers, rules, publications and unknown entries are rejected.
- Every index, constraint, default, sequence and helper function must also be
  named exactly in the SHA-bound manifest's `schemaObjectAllowlist`; unused or
  duplicate allowlist entries are rejected. Functions additionally remain
  restricted in code to `public.default_store_id()` and
  `public.default_saas_instance_id()`.

The existing **20260722 dump and manifest are expressly forbidden for tenant
bootstrap**. They are a real-data database-transfer snapshot (including
non-zero `Order` and `Users` rows), not a tenant template. They must never be
uploaded under a tenant-baseline key or referenced by the provisioning worker.
The generic `scripts/export-local-database.ps1` command now marks future
exports as `purpose: database_transfer` and `dataPolicy: full_copy`, which the
tenant migration task rejects.

Tenant bootstrap manifests must be generated from a dedicated empty template
database. Do not edit a full-data manifest to change its purpose or row counts:
the archive restore and post-restore table counts will fail, and using the
underlying customer data would itself violate this deployment contract.

There is not yet a general ordered migration runner for every SQL file in
`db/`. Until that exists, a fresh-tenant deployment requires an approved,
versioned baseline dump and manifest. The provisioning worker must fail closed
when either artifact is missing; it must never try to assemble or run all SQL
files during application startup.

No tenant baseline digest is currently approved. Therefore
`APPROVED_TENANT_BASELINE_SHA256` intentionally has no deployable value and a
fresh database restore remains fail-closed until an artifact completes the
separate review process.

## Local verification

The repository test suite statically verifies both image pins, the shell-less
non-root runtime, readiness health check, migration major version, ignore rules,
and production environment validation. It also exercises `bcrypt`, whose
production dependency includes a Linux glibc prebuild compatible with the
distroless Debian runtime:

```powershell
npm run check
```

When Docker is installed, also run:

```powershell
docker build --tag speedfeast-backend:s3 .
docker inspect speedfeast-backend:s3 --format '{{json .Config.Healthcheck}}'
docker inspect speedfeast-backend:s3 --format '{{.Config.User}}'
```

An integration readiness check additionally needs a disposable PostgreSQL 16
database. A container without reachable PostgreSQL is expected to answer 200
on `/health`, 503 on `/ready`, and remain unhealthy.
