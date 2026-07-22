#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "Required environment variable ${name} is missing"
}

for name in \
  MIGRATION_S3_URI \
  MIGRATION_SHA256 \
  MIGRATION_MANIFEST_S3_URI \
  MIGRATION_MANIFEST_SHA256 \
  MIGRATION_CONFIRM_SOURCE_DATABASE \
  MIGRATION_CONFIRM_HOST \
  MIGRATION_CONFIRM_DATABASE \
  MIGRATION_CONFIRM_ADMIN_USER \
  PGHOST \
  PGDATABASE \
  PGUSER \
  PGPASSWORD \
  APP_DB_USER \
  APP_DB_PASSWORD; do
  require_env "${name}"
done

export PGPORT="${PGPORT:-5432}"
export PGSSLMODE="${PGSSLMODE:-verify-full}"
export PGSSLROOTCERT="${PGSSLROOTCERT:-/usr/local/share/ca-certificates/aws-rds-global-bundle.pem}"

[[ "${MIGRATION_CONFIRM_HOST}" == "${PGHOST}" ]] || \
  fail "MIGRATION_CONFIRM_HOST must exactly match PGHOST"
[[ "${MIGRATION_CONFIRM_DATABASE}" == "${PGDATABASE}" ]] || \
  fail "MIGRATION_CONFIRM_DATABASE must exactly match PGDATABASE"
[[ "${MIGRATION_CONFIRM_ADMIN_USER}" == "${PGUSER}" ]] || \
  fail "MIGRATION_CONFIRM_ADMIN_USER must exactly match PGUSER"
[[ "${MIGRATION_S3_URI}" == s3://*/_migration/*.dump ]] || \
  fail "MIGRATION_S3_URI must point to an s3://.../_migration/...dump object"
[[ "${MIGRATION_MANIFEST_S3_URI}" == s3://*/_migration/*.manifest.json ]] || \
  fail "MIGRATION_MANIFEST_S3_URI must point to an s3://.../_migration/...manifest.json object"
[[ "${APP_DB_USER}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || \
  fail "APP_DB_USER must be a simple lowercase PostgreSQL role name"
[[ "${APP_DB_USER}" != "${PGUSER}" ]] || \
  fail "APP_DB_USER must not be the RDS administrator role"

expected_sha256="$(printf '%s' "${MIGRATION_SHA256}" | tr '[:upper:]' '[:lower:]')"
expected_manifest_sha256="$(printf '%s' "${MIGRATION_MANIFEST_SHA256}" | tr '[:upper:]' '[:lower:]')"
[[ "${expected_sha256}" =~ ^[0-9a-f]{64}$ ]] || \
  fail "MIGRATION_SHA256 must contain exactly 64 hexadecimal characters"
[[ "${expected_manifest_sha256}" =~ ^[0-9a-f]{64}$ ]] || \
  fail "MIGRATION_MANIFEST_SHA256 must contain exactly 64 hexadecimal characters"

work_dir="$(mktemp -d /tmp/speedfeast-migration.XXXXXX)"
dump_path="${work_dir}/speedfeast.dump"
manifest_path="${work_dir}/speedfeast.manifest.json"
restore_sql_path="${work_dir}/restore.sql"
verification_sql_path="${work_dir}/verify.sql"
pgpass_path="${work_dir}/pgpass"
cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

# Keep both database passwords out of process arguments and unrelated child
# process environments. Only psql receives APP_DB_PASSWORD, immediately before
# it performs the atomic restore transaction.
app_db_user="${APP_DB_USER}"
app_db_password="${APP_DB_PASSWORD}"
unset APP_DB_USER APP_DB_PASSWORD

python3 - "${pgpass_path}" <<'PY'
import os
import pathlib
import sys


def escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:")


fields = [os.environ[name] for name in ("PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD")]
path = pathlib.Path(sys.argv[1])
path.write_text(":".join(escape(value) for value in fields) + "\n", encoding="utf-8")
path.chmod(0o600)
PY
export PGPASSFILE="${pgpass_path}"
unset PGPASSWORD

echo "Downloading the encrypted migration archive and manifest from S3"
aws s3 cp "${MIGRATION_S3_URI}" "${dump_path}" --only-show-errors
aws s3 cp "${MIGRATION_MANIFEST_S3_URI}" "${manifest_path}" --only-show-errors

actual_sha256="$(sha256sum "${dump_path}" | awk '{print $1}')"
actual_manifest_sha256="$(sha256sum "${manifest_path}" | awk '{print $1}')"
[[ "${actual_sha256}" == "${expected_sha256}" ]] || \
  fail "Migration archive SHA-256 does not match MIGRATION_SHA256"
[[ "${actual_manifest_sha256}" == "${expected_manifest_sha256}" ]] || \
  fail "Migration manifest SHA-256 does not match MIGRATION_MANIFEST_SHA256"

echo "Validating the PostgreSQL custom-format archive"
pg_restore --list "${dump_path}" >/dev/null

python3 - \
  "${manifest_path}" \
  "${actual_sha256}" \
  "${MIGRATION_CONFIRM_SOURCE_DATABASE}" \
  "${verification_sql_path}" <<'PY'
import json
import pathlib
import sys


manifest_path, archive_sha256, source_database_name, output_path = sys.argv[1:]
manifest = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))

if manifest.get("format") != "speedfeast-database-migration-manifest/v1":
    raise SystemExit("Unsupported migration manifest format")
if manifest.get("sourceDatabase") != source_database_name:
    raise SystemExit("Manifest sourceDatabase does not match MIGRATION_CONFIRM_SOURCE_DATABASE")
if manifest.get("archiveSha256", "").lower() != archive_sha256:
    raise SystemExit("Manifest archiveSha256 does not match the downloaded archive")

tables = manifest.get("tables")
if not isinstance(tables, list) or not tables:
    raise SystemExit("Migration manifest does not contain any tables")


def sql_identifier(value: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise SystemExit("Manifest contains an invalid PostgreSQL identifier")
    return '"' + value.replace('"', '""') + '"'


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


normalized = []
seen = set()
for table in tables:
    if not isinstance(table, dict):
        raise SystemExit("Manifest tables must be objects")
    schema = table.get("schema")
    name = table.get("table")
    rows = table.get("rows")
    sql_identifier(schema)
    sql_identifier(name)
    if isinstance(rows, bool) or not isinstance(rows, int) or rows < 0 or rows > 9223372036854775807:
        raise SystemExit(f"Manifest contains an invalid row count for {schema}.{name}")
    key = (schema, name)
    if key in seen:
        raise SystemExit(f"Manifest contains a duplicate table: {schema}.{name}")
    seen.add(key)
    normalized.append((schema, name, rows))

normalized.sort(key=lambda item: (item[0], item[1]))
values = ",\n    ".join(
    f"({sql_literal(schema)}, {sql_literal(name)})" for schema, name, _ in normalized
)

parts = [
    "DO $speedfeast_verify_tables$\n",
    "DECLARE\n  mismatch text;\n",
    "BEGIN\n",
    "  WITH expected(schema_name, table_name) AS (\n    VALUES\n    ",
    values,
    "\n  ),\n",
    "  actual(schema_name, table_name) AS (\n",
    "    SELECT schemaname, tablename\n",
    "    FROM pg_tables\n",
    "    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')\n",
    "      AND schemaname NOT LIKE 'pg_toast%'\n",
    "  ),\n",
    "  differences AS (\n",
    "    SELECT 'missing' AS kind, schema_name, table_name FROM (TABLE expected EXCEPT TABLE actual) AS missing\n",
    "    UNION ALL\n",
    "    SELECT 'unexpected' AS kind, schema_name, table_name FROM (TABLE actual EXCEPT TABLE expected) AS unexpected\n",
    "  )\n",
    "  SELECT string_agg(kind || ':' || quote_ident(schema_name) || '.' || quote_ident(table_name), ', ')\n",
    "  INTO mismatch\n",
    "  FROM differences;\n",
    "\n",
    "  IF mismatch IS NOT NULL THEN\n",
    "    RAISE EXCEPTION 'Restored table set differs from the manifest: %', mismatch;\n",
    "  END IF;\n",
    "END\n",
    "$speedfeast_verify_tables$;\n\n",
]

for schema, name, expected_rows in normalized:
    parts.extend(
        [
            "DO $speedfeast_verify_rows$\n",
            "DECLARE\n  actual_rows bigint;\n",
            "BEGIN\n",
            f"  SELECT count(*) INTO actual_rows FROM {sql_identifier(schema)}.{sql_identifier(name)};\n",
            f"  IF actual_rows <> {expected_rows} THEN\n",
            "    RAISE EXCEPTION 'Row count mismatch for %.%: expected %, got %', ",
            f"{sql_literal(schema)}, {sql_literal(name)}, {expected_rows}, actual_rows;\n",
            "  END IF;\n",
            "END\n",
            "$speedfeast_verify_rows$;\n\n",
        ]
    )

pathlib.Path(output_path).write_text("".join(parts), encoding="utf-8")
PY

server_version_num="$(psql --no-psqlrc --tuples-only --no-align --command='SHOW server_version_num')"
[[ "${server_version_num}" =~ ^18[0-9]{4}$ ]] || \
  fail "Destination must be PostgreSQL 18; server_version_num=${server_version_num}"

target_identity="$(
  psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    --command="SELECT current_database() || '|' || current_user"
)"
[[ "${target_identity}" == "${PGDATABASE}|${PGUSER}" ]] || \
  fail "Connected database identity does not match the confirmed target"

existing_object_summary="$(
  psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 <<'SQL'
WITH object_counts AS (
  SELECT
    (SELECT count(*)
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg_toast%'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')) AS relations,
    (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql') AS extensions,
    (SELECT count(*)
       FROM pg_proc AS routine
       JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg_toast%') AS routines,
    (SELECT count(*)
       FROM pg_type AS type
       JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg_toast%'
        AND type.typtype IN ('d', 'e', 'r', 'm')) AS types,
    (SELECT count(*)
       FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
        AND nspname NOT LIKE 'pg_toast%') AS schemas,
    (SELECT count(*) FROM pg_event_trigger) AS event_triggers,
    (SELECT count(*) FROM pg_publication) AS publications
)
SELECT format(
  'relations=%s,extensions=%s,routines=%s,types=%s,schemas=%s,event_triggers=%s,publications=%s',
  relations,
  extensions,
  routines,
  types,
  schemas,
  event_triggers,
  publications
)
FROM object_counts;
SQL
)"
[[ "${existing_object_summary}" == "relations=0,extensions=0,routines=0,types=0,schemas=0,event_triggers=0,publications=0" ]] || \
  fail "Destination database contains user objects (${existing_object_summary}); restore was not started"

echo "Rendering the archive into an atomic restore script"
pg_restore \
  --file="${restore_sql_path}" \
  --no-owner \
  --no-privileges \
  "${dump_path}"

echo "Restoring, validating every table, and granting application access in one transaction"
{
  printf '\\set ON_ERROR_STOP on\n'
  printf '\\set VERBOSITY terse\n'
  printf 'BEGIN;\n'
  cat "${restore_sql_path}"
  cat "${verification_sql_path}"
  cat <<'SQL'
\getenv app_role APP_DB_USER
\getenv app_password APP_DB_PASSWORD

SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'app_role'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
\gexec

SELECT format('ALTER ROLE %I SET search_path = public', :'app_role')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_role')
\gexec

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role')
\gexec

SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
  :'app_role'
)
\gexec

SELECT format(
  'GRANT SELECT, USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I',
  :'app_role'
)
\gexec

SELECT format('GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO %I', :'app_role')
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  current_user,
  :'app_role'
)
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, USAGE, UPDATE ON SEQUENCES TO %I',
  current_user,
  :'app_role'
)
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON ROUTINES TO %I',
  current_user,
  :'app_role'
)
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L',
  :'app_role',
  :'app_password'
)
\gexec

COMMIT;
SQL
} | APP_DB_USER="${app_db_user}" APP_DB_PASSWORD="${app_db_password}" \
  psql --no-psqlrc --set=ON_ERROR_STOP=1

unset app_db_password

if ! vacuumdb --dbname="${PGDATABASE}" --analyze-in-stages --quiet; then
  echo "WARNING: restore succeeded, but planner statistics could not be refreshed; run ANALYZE later" >&2
fi

restored_table_count="$(
  psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  AND schemaname NOT LIKE 'pg_toast%';
SQL
)"

echo "Migration completed successfully: ${restored_table_count} tables restored and row counts verified"
