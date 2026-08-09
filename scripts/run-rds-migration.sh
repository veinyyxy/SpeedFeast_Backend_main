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

# libpq reads these variables independently of command-line connection flags.
# Reject (and clear) every inherited override that could select another target,
# service definition, authentication policy, or TLS identity. PGPASSFILE is the
# sole exception: it is replaced below with a task-private file before psql runs.
for name in \
  PGSERVICE \
  PGSERVICEFILE \
  PGOPTIONS \
  PGSYSCONFDIR \
  PGHOSTADDR \
  PGTARGETSESSIONATTRS \
  PGLOADBALANCEHOSTS \
  PGCHANNELBINDING \
  PGREQUIREAUTH \
  PGSSLCERT \
  PGSSLKEY \
  PGSSLCRL \
  PGSSLCRLDIR \
  PGSSLSNI \
  PGSSLNEGOTIATION \
  PGSSLCOMPRESSION \
  PGSSLMINPROTOCOLVERSION \
  PGSSLMAXPROTOCOLVERSION \
  PGGSSENCMODE \
  PGGSSLIB \
  PGKRBSRVNAME \
  PGREQUIREPEER; do
  if [[ -v "${name}" ]]; then
    unset "${name}"
    fail "Inherited libpq override ${name} is not permitted"
  fi
done

for name in \
  MIGRATION_S3_URI \
  MIGRATION_SHA256 \
  APPROVED_TENANT_BASELINE_SHA256 \
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
  PGSSLMODE \
  PGSSLROOTCERT \
  PGSSL_REJECT_UNAUTHORIZED \
  APP_DB_USER \
  APP_DB_PASSWORD; do
  require_env "${name}"
done

export PGPORT="${PGPORT:-5432}"
rds_root_certificate="/usr/local/share/ca-certificates/aws-rds-global-bundle.pem"
rds_root_certificate_sha256="e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3"
maximum_dump_bytes=$((500 * 1024 * 1024))
maximum_manifest_bytes=$((1 * 1024 * 1024))

[[ "${PGHOST}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || \
  fail "PGHOST must be one DNS hostname"
[[ "${PGHOST}" == *.* ]] || \
  fail "PGHOST must be a fully qualified DNS hostname"
[[ "${PGPORT}" =~ ^[1-9][0-9]{0,4}$ ]] && (( PGPORT <= 65535 )) || \
  fail "PGPORT must be an integer between 1 and 65535"
[[ "${PGDATABASE}" =~ ^[A-Za-z_][A-Za-z0-9_$]{0,62}$ ]] || \
  fail "PGDATABASE must be a simple PostgreSQL database name"
[[ "${PGUSER}" =~ ^[A-Za-z_][A-Za-z0-9_$]{0,62}$ ]] || \
  fail "PGUSER must be a simple PostgreSQL role name"
[[ "${PGSSLMODE}" == "verify-full" ]] || \
  fail "PGSSLMODE must be verify-full"
[[ "${PGSSL_REJECT_UNAUTHORIZED,,}" == "true" ]] || \
  fail "PGSSL_REJECT_UNAUTHORIZED must be true"
[[ "${PGSSLROOTCERT}" == "${rds_root_certificate}" ]] || \
  fail "PGSSLROOTCERT must use the image-bundled AWS RDS global certificate"
[[ -r "${PGSSLROOTCERT}" ]] || \
  fail "PGSSLROOTCERT must reference a readable CA bundle"
actual_root_certificate_sha256="$(sha256sum "${PGSSLROOTCERT}" | awk '{print $1}')"
[[ "${actual_root_certificate_sha256}" == "${rds_root_certificate_sha256}" ]] || \
  fail "The image-bundled AWS RDS root certificate failed SHA-256 verification"

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
case "${APP_DB_USER}" in
  pg_*|rds*|postgres|public|current_role|current_user|session_user|none)
    fail "APP_DB_USER uses a PostgreSQL or RDS reserved role name"
    ;;
esac

expected_sha256="$(printf '%s' "${MIGRATION_SHA256}" | tr '[:upper:]' '[:lower:]')"
approved_sha256="$(printf '%s' "${APPROVED_TENANT_BASELINE_SHA256}" | tr '[:upper:]' '[:lower:]')"
expected_manifest_sha256="$(printf '%s' "${MIGRATION_MANIFEST_SHA256}" | tr '[:upper:]' '[:lower:]')"
[[ "${expected_sha256}" =~ ^[0-9a-f]{64}$ ]] || \
  fail "MIGRATION_SHA256 must contain exactly 64 hexadecimal characters"
[[ "${approved_sha256}" =~ ^[0-9a-f]{64}$ ]] || \
  fail "APPROVED_TENANT_BASELINE_SHA256 must contain exactly 64 hexadecimal characters"
[[ "${expected_sha256}" == "${approved_sha256}" ]] || \
  fail "MIGRATION_SHA256 is not the independently approved tenant baseline digest"
[[ "${expected_manifest_sha256}" =~ ^[0-9a-f]{64}$ ]] || \
  fail "MIGRATION_MANIFEST_SHA256 must contain exactly 64 hexadecimal characters"

work_dir="$(mktemp -d /tmp/speedfeast-migration.XXXXXX)"
dump_path="${work_dir}/speedfeast.dump"
manifest_path="${work_dir}/speedfeast.manifest.json"
restore_sql_path="${work_dir}/restore.sql"
verification_sql_path="${work_dir}/verify.sql"
toc_path="${work_dir}/restore.toc"
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

target_psql() {
  PGPASSFILE="${PGPASSFILE}" \
  PGSSLMODE="${PGSSLMODE}" \
  PGSSLROOTCERT="${PGSSLROOTCERT}" \
    command psql \
      --host="${PGHOST}" \
      --port="${PGPORT}" \
      --dbname="${PGDATABASE}" \
      --username="${PGUSER}" \
      "$@"
}

target_vacuumdb() {
  PGPASSFILE="${PGPASSFILE}" \
  PGSSLMODE="${PGSSLMODE}" \
  PGSSLROOTCERT="${PGSSLROOTCERT}" \
    command vacuumdb \
      --host="${PGHOST}" \
      --port="${PGPORT}" \
      --dbname="${PGDATABASE}" \
      --username="${PGUSER}" \
      "$@"
}

# These pg_restore invocations only inspect/render a custom archive and must
# never connect. A clean environment prevents an inherited libpq setting from
# turning an offline validation step into an unintended database operation.
offline_pg_restore() {
  env -i PATH="${PATH}" LC_ALL=C pg_restore "$@"
}

echo "Downloading the encrypted migration archive and manifest from S3"
aws s3 cp "${MIGRATION_S3_URI}" "${dump_path}" --only-show-errors
dump_size_bytes="$(stat --format='%s' "${dump_path}")"
[[ "${dump_size_bytes}" =~ ^[0-9]+$ ]] && (( dump_size_bytes <= maximum_dump_bytes )) || \
  fail "Migration archive exceeds the 500 MiB tenant baseline limit"

aws s3 cp "${MIGRATION_MANIFEST_S3_URI}" "${manifest_path}" --only-show-errors
manifest_size_bytes="$(stat --format='%s' "${manifest_path}")"
[[ "${manifest_size_bytes}" =~ ^[0-9]+$ ]] && (( manifest_size_bytes <= maximum_manifest_bytes )) || \
  fail "Migration manifest exceeds the 1 MiB tenant baseline limit"

actual_sha256="$(sha256sum "${dump_path}" | awk '{print $1}')"
actual_manifest_sha256="$(sha256sum "${manifest_path}" | awk '{print $1}')"
[[ "${actual_sha256}" == "${expected_sha256}" ]] || \
  fail "Migration archive SHA-256 does not match MIGRATION_SHA256"
[[ "${actual_sha256}" == "${approved_sha256}" ]] || \
  fail "Migration archive SHA-256 is not the independently approved tenant baseline digest"
[[ "${actual_manifest_sha256}" == "${expected_manifest_sha256}" ]] || \
  fail "Migration manifest SHA-256 does not match MIGRATION_MANIFEST_SHA256"

echo "Validating the PostgreSQL custom-format archive"
offline_pg_restore --list "${dump_path}" >"${toc_path}"

# This gate deliberately runs before any target-database inspection or restore.
# A generic local export, even when its hashes are valid, is never a tenant
# baseline unless its manifest declares the restricted tenant-bootstrap policy.
python3 /usr/local/lib/speedfeast/render_tenant_baseline_verification.py \
  "${manifest_path}" \
  "${actual_sha256}" \
  "${MIGRATION_CONFIRM_SOURCE_DATABASE}" \
  "${toc_path}" \
  "${verification_sql_path}"

server_version_num="$(target_psql --no-psqlrc --tuples-only --no-align --command='SHOW server_version_num')"
[[ "${server_version_num}" =~ ^16[0-9]{4}$ ]] || \
  fail "Destination must be PostgreSQL 16; server_version_num=${server_version_num}"

target_identity="$(
  target_psql --no-psqlrc --tuples-only --no-align --field-separator='|' \
    --set=ON_ERROR_STOP=1 --command="
      SELECT
        current_database(),
        current_user,
        inet_server_addr()::text,
        inet_server_port()::text,
        EXISTS (
          SELECT 1
          FROM pg_stat_ssl
          WHERE pid = pg_backend_pid() AND ssl
        )::text
    "
)"
IFS='|' read -r connected_database connected_user connected_address connected_port connected_ssl \
  <<<"${target_identity}"
[[ "${connected_database}" == "${PGDATABASE}" ]] || \
  fail "Connected database does not match the confirmed target"
[[ "${connected_user}" == "${PGUSER}" ]] || \
  fail "Connected user does not match the confirmed administrator"
[[ "${connected_port}" == "${PGPORT}" ]] || \
  fail "Connected server port does not match PGPORT"
[[ -n "${connected_address}" ]] || \
  fail "Connected server did not report inet_server_addr()"
[[ "${connected_ssl}" == "true" ]] || \
  fail "Connected PostgreSQL session is not using SSL"

python3 - "${PGHOST}" "${PGPORT}" "${connected_address}" <<'PY'
import ipaddress
import socket
import sys

host, port, connected = sys.argv[1:]
try:
    connected_ip = ipaddress.ip_address(connected)
    resolved = {
        ipaddress.ip_address(item[4][0])
        for item in socket.getaddrinfo(host, int(port), type=socket.SOCK_STREAM)
    }
except (OSError, ValueError) as error:
    raise SystemExit(f"Target DNS/address verification failed: {error}")
if connected_ip not in resolved:
    raise SystemExit(
        f"Connected server address {connected_ip} is not a current address for {host}"
    )
PY

app_role_state="$(
  target_psql --no-psqlrc --tuples-only --no-align --field-separator='|' \
    --set=ON_ERROR_STOP=1 --set="app_role=${app_db_user}" <<'SQL'
SELECT
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')::text,
  EXISTS (
    SELECT 1 FROM pg_get_keywords()
    WHERE word = lower(:'app_role') AND catcode = 'R'
  )::text;
SQL
)"
[[ "${app_role_state}" == "false|false" ]] || \
  fail "APP_DB_USER already exists or is a reserved PostgreSQL keyword; refusing role takeover"

existing_object_summary="$(
  target_psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 <<'SQL'
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
offline_pg_restore \
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
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'app_role',
  :'app_password'
)
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

COMMIT;
SQL
} | APP_DB_USER="${app_db_user}" APP_DB_PASSWORD="${app_db_password}" \
  target_psql --no-psqlrc --set=ON_ERROR_STOP=1

unset app_db_password

if ! target_vacuumdb --analyze-in-stages --quiet; then
  echo "WARNING: restore succeeded, but planner statistics could not be refreshed; run ANALYZE later" >&2
fi

restored_table_count="$(
  target_psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  AND schemaname NOT LIKE 'pg_toast%';
SQL
)"

echo "Migration completed successfully: ${restored_table_count} tables restored and row counts verified"
