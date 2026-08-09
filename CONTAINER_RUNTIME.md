# SpeedFeast container runtime contract

The application image is the same artifact in AWS Sandbox and production. A
deployment promotes an immutable ECR digest; it does not rebuild source code or
bake tenant configuration into the image. Sandbox and production differ only
in runtime configuration, secrets, resource sizing, and routing.

## Image invariants

- The runtime is pinned to the official Node.js `24.18.0-bookworm-slim`
  multi-platform digest.
- The final process runs as the built-in unprivileged `node` user.
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
3. Run the application image once with command `npm run migrate:saas`. This
   applies `db/saas_control.sql` and `db/theme_config.sql` in one transaction;
   both scripts are idempotent.
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

The repository test suite statically verifies the image pin, non-root runtime,
readiness health check, migration major version, ignore rules, and production
environment validation:

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
