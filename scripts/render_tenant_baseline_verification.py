#!/usr/bin/env python3
"""Validate a tenant bootstrap manifest and render post-restore SQL checks."""

from __future__ import annotations

import json
import pathlib
import re
import sys
from typing import Any


MANIFEST_FORMAT = "speedfeast-database-migration-manifest/v1"
TENANT_BOOTSTRAP_PURPOSE = "tenant_bootstrap"
SCHEMA_ONLY_POLICY = "schema_only"
ALLOWLISTED_SEED_POLICY = "allowlisted_seed_tables"
MAX_RESTORE_TOC_ENTRIES = 20_000

# Seed data must be approved in code as well as named by the manifest. A
# manifest author cannot opt a customer, order or other business table into a
# tenant baseline merely by adding its name to seedTableAllowlist.
APPROVED_SEED_TABLES = frozenset(
    {
        ("public", "merchant_permissions"),
        ("public", "merchant_role_permissions"),
    }
)
APPROVED_FUNCTIONS = frozenset(
    {
        ("public", "default_saas_instance_id()"),
        ("public", "default_store_id()"),
    }
)
SIMPLE_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
KNOWN_TOC_DESCRIPTORS = tuple(
    sorted(
        {
            "ACCESS METHOD",
            "ACL",
            "AGGREGATE",
            "BLOB COMMENTS",
            "BLOBS",
            "BLOB",
            "CAST",
            "CHECK CONSTRAINT",
            "COLLATION",
            "COMMENT",
            "CONSTRAINT",
            "CONVERSION",
            "DATABASE PROPERTIES",
            "DEFAULT ACL",
            "DEFAULT",
            "DOMAIN CONSTRAINT",
            "DOMAIN",
            "ENCODING",
            "EVENT TRIGGER",
            "EXTENSION",
            "FK CONSTRAINT",
            "FOREIGN DATA WRAPPER",
            "FOREIGN SERVER",
            "FOREIGN TABLE",
            "FUNCTION",
            "INDEX ATTACH",
            "INDEX",
            "MATERIALIZED VIEW DATA",
            "MATERIALIZED VIEW",
            "OPERATOR CLASS",
            "OPERATOR FAMILY",
            "OPERATOR",
            "POLICY",
            "PROCEDURE",
            "PUBLICATION TABLE",
            "PUBLICATION",
            "ROW SECURITY",
            "RULE",
            "SCHEMA",
            "SEARCHPATH",
            "SECURITY LABEL",
            "SEQUENCE OWNED BY",
            "SEQUENCE SET",
            "SEQUENCE",
            "SERVER",
            "STATISTICS",
            "STDSTRINGS",
            "TABLE ATTACH",
            "TABLE DATA",
            "TABLE",
            "TEXT SEARCH CONFIGURATION",
            "TEXT SEARCH DICTIONARY",
            "TEXT SEARCH PARSER",
            "TEXT SEARCH TEMPLATE",
            "TRANSFORM",
            "TRIGGER",
            "TYPE",
            "USER MAPPING",
            "VIEW",
        },
        key=len,
        reverse=True,
    )
)

SENSITIVE_TABLE_NAMES = frozenset(
    {
        "order",
        "orders",
        "orderitems",
        "order_items",
        "orderitem_options",
        "users",
        "stores",
        "store_customers",
        "store_products",
        "store_categories",
        "store_product_categories",
        "dining_tables",
        "media_assets",
        "product_images",
        "saas_instances",
        "saas_entitlements",
        "saas_licenses",
        "saas_access_leases",
        "saas_usage_snapshots",
        "saas_provisioning_operations",
        "saas_audit_logs",
    }
)
SENSITIVE_NAME_FRAGMENT = re.compile(
    r"(user|customer|order|payment|refund|review|notification|device_token|"
    r"loyalty|reward|redemption|audit|license|access_lease)"
)


class ManifestValidationError(ValueError):
    """A tenant baseline manifest violates the fail-closed contract."""


def sql_identifier(value: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ManifestValidationError("Manifest contains an invalid PostgreSQL identifier")
    return '"' + value.replace('"', '""') + '"'


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def normalized_table_key(value: str) -> tuple[str, str]:
    if not isinstance(value, str) or value.count(".") != 1:
        raise ManifestValidationError(
            "seedTableAllowlist entries must use schema.table names"
        )
    schema, name = value.split(".", 1)
    sql_identifier(schema)
    sql_identifier(name)
    return schema.casefold(), name.casefold()


def is_sensitive_table(schema: str, name: str) -> bool:
    del schema
    normalized_name = name.casefold()
    return (
        normalized_name in SENSITIVE_TABLE_NAMES
        or SENSITIVE_NAME_FRAGMENT.search(normalized_name) is not None
    )


def require_simple_identifier(value: str, description: str) -> None:
    if not isinstance(value, str) or SIMPLE_IDENTIFIER.fullmatch(value) is None:
        raise ManifestValidationError(
            f"Restore TOC contains an invalid {description} identifier"
        )


def toc_descriptor(payload: str) -> tuple[str, list[str]]:
    for descriptor in KNOWN_TOC_DESCRIPTORS:
        if payload == descriptor or payload.startswith(descriptor + " "):
            details = payload[len(descriptor) :].strip().split()
            return descriptor, details
    raise ManifestValidationError(
        "Restore TOC contains an unknown or unapproved object descriptor"
    )


def validate_restore_toc(
    toc_text: str,
    manifest: dict[str, Any],
    normalized: list[tuple[str, str, int]],
) -> None:
    manifest_tables = {
        (schema.casefold(), name.casefold()) for schema, name, _ in normalized
    }
    if manifest.get("dataPolicy") == ALLOWLISTED_SEED_POLICY:
        allowed_table_data = {
            normalized_table_key(value)
            for value in manifest.get("seedTableAllowlist", [])
        }
    else:
        allowed_table_data = set()

    raw_schema_allowlist = manifest.get("schemaObjectAllowlist", [])
    if not isinstance(raw_schema_allowlist, list):
        raise ManifestValidationError("schemaObjectAllowlist must be an array")
    schema_object_allowlist: set[str] = set()
    for value in raw_schema_allowlist:
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 512
            or any(character in value for character in "\r\n\x00")
        ):
            raise ManifestValidationError(
                "schemaObjectAllowlist contains an invalid entry"
            )
        schema_object_allowlist.add(value)
    if len(schema_object_allowlist) != len(raw_schema_allowlist):
        raise ManifestValidationError("schemaObjectAllowlist contains duplicate entries")
    used_schema_objects: set[str] = set()

    def require_manifest_schema_object(value: str) -> None:
        if value not in schema_object_allowlist:
            raise ManifestValidationError(
                f"Restore TOC schema object is not approved by the manifest: {value}"
            )
        used_schema_objects.add(value)

    seen_dump_ids: set[str] = set()
    toc_tables: set[tuple[str, str]] = set()
    table_data_entries: set[tuple[str, str]] = set()
    entry_count = 0
    for line_number, raw_line in enumerate(toc_text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith(";"):
            continue
        match = re.fullmatch(r"([0-9]+);\s+([0-9]+)\s+([0-9]+)\s+(.+)", line)
        if match is None:
            raise ManifestValidationError(
                f"Restore TOC line {line_number} has an invalid format"
            )
        dump_id, _catalog_oid, _object_oid, payload = match.groups()
        if dump_id in seen_dump_ids:
            raise ManifestValidationError("Restore TOC contains duplicate dump IDs")
        seen_dump_ids.add(dump_id)
        entry_count += 1
        if entry_count > MAX_RESTORE_TOC_ENTRIES:
            raise ManifestValidationError(
                "Restore TOC exceeds the maximum approved entry count"
            )

        descriptor, details = toc_descriptor(payload)
        if descriptor in {"ENCODING", "STDSTRINGS", "SEARCHPATH"}:
            if len(details) < 2 or details[0] != "-" or details[1] != descriptor:
                raise ManifestValidationError(
                    f"Restore TOC contains an invalid {descriptor} metadata entry"
                )
            continue
        if descriptor == "SCHEMA":
            if len(details) < 3 or details[0] != "-" or details[1] != "public":
                raise ManifestValidationError(
                    "Restore TOC may create only the public schema"
                )
            continue
        if descriptor in {"TABLE", "TABLE DATA"}:
            if len(details) < 3:
                raise ManifestValidationError(
                    f"Restore TOC contains an invalid {descriptor} entry"
                )
            schema, name = details[:2]
            require_simple_identifier(schema, "schema")
            require_simple_identifier(name, "table")
            key = (schema.casefold(), name.casefold())
            if schema.casefold() != "public" or key not in manifest_tables:
                raise ManifestValidationError(
                    f"Restore TOC {descriptor} is not declared by the manifest: {schema}.{name}"
                )
            if descriptor == "TABLE":
                if key in toc_tables:
                    raise ManifestValidationError(
                        f"Restore TOC contains a duplicate table: {schema}.{name}"
                    )
                toc_tables.add(key)
            else:
                if key not in allowed_table_data:
                    raise ManifestValidationError(
                        f"Restore TOC TABLE DATA is forbidden for tenant table: {schema}.{name}"
                    )
                if key in table_data_entries:
                    raise ManifestValidationError(
                        f"Restore TOC contains duplicate TABLE DATA: {schema}.{name}"
                    )
                table_data_entries.add(key)
            continue
        if descriptor in {"SEQUENCE", "SEQUENCE OWNED BY"}:
            if len(details) < 3 or details[0].casefold() != "public":
                raise ManifestValidationError(
                    f"Restore TOC contains an invalid {descriptor} entry"
                )
            require_simple_identifier(details[0], "schema")
            require_simple_identifier(details[1], "sequence")
            require_manifest_schema_object(f"SEQUENCE {details[0]}.{details[1]}")
            continue
        if descriptor == "DEFAULT":
            if len(details) < 4:
                raise ManifestValidationError("Restore TOC contains an invalid DEFAULT entry")
            schema, table, column = details[:3]
            require_simple_identifier(schema, "schema")
            require_simple_identifier(table, "table")
            require_simple_identifier(column, "column")
            if (schema.casefold(), table.casefold()) not in manifest_tables:
                raise ManifestValidationError(
                    f"Restore TOC DEFAULT targets an undeclared table: {schema}.{table}"
                )
            require_manifest_schema_object(f"DEFAULT {schema}.{table}.{column}")
            continue
        if descriptor in {"CONSTRAINT", "CHECK CONSTRAINT", "FK CONSTRAINT"}:
            if len(details) < 4:
                raise ManifestValidationError(
                    f"Restore TOC contains an invalid {descriptor} entry"
                )
            schema, table, constraint = details[:3]
            require_simple_identifier(schema, "schema")
            require_simple_identifier(table, "table")
            require_simple_identifier(constraint, "constraint")
            if (schema.casefold(), table.casefold()) not in manifest_tables:
                raise ManifestValidationError(
                    f"Restore TOC {descriptor} targets an undeclared table: {schema}.{table}"
                )
            require_manifest_schema_object(
                f"{descriptor} {schema}.{table}.{constraint}"
            )
            continue
        if descriptor == "INDEX":
            if len(details) < 3 or details[0].casefold() != "public":
                raise ManifestValidationError("Restore TOC contains an invalid INDEX entry")
            require_simple_identifier(details[0], "schema")
            require_simple_identifier(details[1], "index")
            require_manifest_schema_object(f"INDEX {details[0]}.{details[1]}")
            continue
        if descriptor == "FUNCTION":
            if len(details) < 3:
                raise ManifestValidationError("Restore TOC contains an invalid FUNCTION entry")
            function_key = (details[0].casefold(), details[1].casefold())
            if function_key not in APPROVED_FUNCTIONS:
                raise ManifestValidationError(
                    f"Restore TOC FUNCTION is not approved: {details[0]}.{details[1]}"
                )
            require_manifest_schema_object(
                f"FUNCTION {details[0]}.{details[1]}"
            )
            continue

        # Extensions, ACLs, BLOBs, security labels, event triggers, foreign
        # objects, executable rules/triggers, publications and every other TOC
        # descriptor are denied unless explicitly handled above.
        raise ManifestValidationError(
            f"Restore TOC object type is forbidden for tenant bootstrap: {descriptor}"
        )

    if entry_count == 0:
        raise ManifestValidationError("Restore TOC does not contain any entries")
    if toc_tables != manifest_tables:
        missing = manifest_tables - toc_tables
        unexpected = toc_tables - manifest_tables
        details = [
            *(f"missing:{schema}.{name}" for schema, name in sorted(missing)),
            *(f"unexpected:{schema}.{name}" for schema, name in sorted(unexpected)),
        ]
        raise ManifestValidationError(
            "Restore TOC table set differs from the manifest: " + ", ".join(details)
        )
    unused_schema_objects = schema_object_allowlist - used_schema_objects
    if unused_schema_objects:
        raise ManifestValidationError(
            "schemaObjectAllowlist contains entries absent from the restore TOC: "
            + ", ".join(sorted(unused_schema_objects))
        )


def validate_manifest(
    manifest: Any,
    archive_sha256: str,
    source_database_name: str,
) -> list[tuple[str, str, int]]:
    if not isinstance(manifest, dict):
        raise ManifestValidationError("Migration manifest must be a JSON object")
    if manifest.get("format") != MANIFEST_FORMAT:
        raise ManifestValidationError("Unsupported migration manifest format")
    if manifest.get("purpose") != TENANT_BOOTSTRAP_PURPOSE:
        raise ManifestValidationError(
            "Manifest purpose must be tenant_bootstrap; general database exports are forbidden"
        )
    if manifest.get("sourceDatabase") != source_database_name:
        raise ManifestValidationError(
            "Manifest sourceDatabase does not match MIGRATION_CONFIRM_SOURCE_DATABASE"
        )
    if str(manifest.get("archiveSha256", "")).lower() != archive_sha256:
        raise ManifestValidationError(
            "Manifest archiveSha256 does not match the downloaded archive"
        )

    data_policy = manifest.get("dataPolicy")
    if not isinstance(data_policy, str) or data_policy not in {
        SCHEMA_ONLY_POLICY,
        ALLOWLISTED_SEED_POLICY,
    }:
        raise ManifestValidationError(
            "Manifest dataPolicy must be schema_only or allowlisted_seed_tables"
        )

    tables = manifest.get("tables")
    if not isinstance(tables, list) or not tables:
        raise ManifestValidationError("Migration manifest does not contain any tables")

    normalized: list[tuple[str, str, int]] = []
    normalized_keys: set[tuple[str, str]] = set()
    for table in tables:
        if not isinstance(table, dict):
            raise ManifestValidationError("Manifest tables must be objects")
        schema = table.get("schema")
        name = table.get("table")
        rows = table.get("rows")
        sql_identifier(schema)
        sql_identifier(name)
        if (
            isinstance(rows, bool)
            or not isinstance(rows, int)
            or rows < 0
            or rows > 9223372036854775807
        ):
            raise ManifestValidationError(
                f"Manifest contains an invalid row count for {schema}.{name}"
            )
        normalized_key = (schema.casefold(), name.casefold())
        if normalized_key in normalized_keys:
            raise ManifestValidationError(
                f"Manifest contains a duplicate table: {schema}.{name}"
            )
        normalized_keys.add(normalized_key)
        normalized.append((schema, name, rows))

    populated_sensitive_tables = sorted(
        f"{schema}.{name}"
        for schema, name, rows in normalized
        if rows > 0 and is_sensitive_table(schema, name)
    )
    if populated_sensitive_tables:
        raise ManifestValidationError(
            "Tenant bootstrap sensitive business tables must have zero rows: "
            + ", ".join(populated_sensitive_tables)
        )

    populated_keys = {
        (schema.casefold(), name.casefold())
        for schema, name, rows in normalized
        if rows > 0
    }
    if data_policy == SCHEMA_ONLY_POLICY:
        if populated_keys:
            populated_names = sorted(f"{schema}.{name}" for schema, name in populated_keys)
            raise ManifestValidationError(
                "schema_only tenant bootstrap requires every table to have zero rows: "
                + ", ".join(populated_names)
            )
        if manifest.get("seedTableAllowlist") not in (None, []):
            raise ManifestValidationError(
                "schema_only tenant bootstrap cannot declare seedTableAllowlist"
            )
    else:
        raw_allowlist = manifest.get("seedTableAllowlist")
        if not isinstance(raw_allowlist, list) or not raw_allowlist:
            raise ManifestValidationError(
                "allowlisted_seed_tables requires a non-empty seedTableAllowlist"
            )
        allowlist = {normalized_table_key(value) for value in raw_allowlist}
        if len(allowlist) != len(raw_allowlist):
            raise ManifestValidationError("seedTableAllowlist contains duplicate entries")
        unapproved = allowlist - APPROVED_SEED_TABLES
        if unapproved:
            names = sorted(f"{schema}.{name}" for schema, name in unapproved)
            raise ManifestValidationError(
                "seedTableAllowlist contains tables not approved by application policy: "
                + ", ".join(names)
            )
        absent = allowlist - normalized_keys
        if absent:
            names = sorted(f"{schema}.{name}" for schema, name in absent)
            raise ManifestValidationError(
                "seedTableAllowlist contains tables absent from the manifest: "
                + ", ".join(names)
            )
        outside_allowlist = populated_keys - allowlist
        if outside_allowlist:
            names = sorted(f"{schema}.{name}" for schema, name in outside_allowlist)
            raise ManifestValidationError(
                "Tenant bootstrap contains rows outside seedTableAllowlist: "
                + ", ".join(names)
            )

    normalized.sort(key=lambda item: (item[0], item[1]))
    return normalized


def render_verification_sql(normalized: list[tuple[str, str, int]]) -> str:
    values = ",\n    ".join(
        f"({sql_literal(schema)}, {sql_literal(name)})"
        for schema, name, _ in normalized
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
    return "".join(parts)


def main(argv: list[str]) -> int:
    if len(argv) != 6:
        print(
            "Usage: render_tenant_baseline_verification.py "
            "MANIFEST ARCHIVE_SHA256 SOURCE_DATABASE RESTORE_TOC OUTPUT_SQL",
            file=sys.stderr,
        )
        return 2

    (
        manifest_path,
        archive_sha256,
        source_database_name,
        toc_path,
        output_path,
    ) = argv[1:]
    try:
        manifest = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
        normalized = validate_manifest(
            manifest,
            archive_sha256.lower(),
            source_database_name,
        )
        validate_restore_toc(
            pathlib.Path(toc_path).read_text(encoding="utf-8"),
            manifest,
            normalized,
        )
        pathlib.Path(output_path).write_text(
            render_verification_sql(normalized),
            encoding="utf-8",
        )
    except (OSError, json.JSONDecodeError, ManifestValidationError) as error:
        print(f"Tenant bootstrap manifest rejected: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
