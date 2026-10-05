"""Compile a schema-only candidate; never approve or restore a database."""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys

from render_tenant_baseline_verification import (
    MANIFEST_FORMAT,
    MAX_RESTORE_TOC_ENTRIES,
    ManifestValidationError,
    render_verification_sql,
    toc_descriptor,
    validate_manifest,
    validate_restore_toc,
)


def compile_candidate(toc: str, archive_sha256: str, source_database: str, *, schema_profile=None, program_sql=None):
    if not re.fullmatch(r"[a-f0-9]{64}", archive_sha256):
        raise ValueError("Invalid archive digest")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]{0,62}", source_database):
        raise ValueError("Invalid source database identifier")
    tables = []
    objects = set()
    entries = 0
    for line in toc.splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        entries += 1
        if entries > MAX_RESTORE_TOC_ENTRIES:
            raise ValueError("TOC exceeds candidate limit")
        match = re.fullmatch(r"[0-9]+;\s+[0-9]+\s+[0-9]+\s+(.+)", line)
        if not match:
            raise ValueError("Invalid TOC entry")
        descriptor, details = toc_descriptor(match.group(1))
        # Never convert an archive containing data into an 'empty' manifest.
        if descriptor in {"TABLE DATA", "SEQUENCE SET", "BLOB", "BLOBS", "BLOB COMMENTS"}:
            raise ValueError("Data-bearing archive is forbidden")
        if descriptor == "TABLE" and len(details) >= 3:
            tables.append({"schema": details[0], "table": details[1], "rows": 0})
        elif descriptor in {"SEQUENCE", "SEQUENCE OWNED BY"} and len(details) >= 3:
            objects.add(f"SEQUENCE {details[0]}.{details[1]}")
        elif descriptor in {"DEFAULT", "CONSTRAINT", "CHECK CONSTRAINT", "FK CONSTRAINT"} and len(details) >= 4:
            objects.add(f"{descriptor} {details[0]}.{details[1]}.{details[2]}")
        elif descriptor in {"INDEX", "FUNCTION"} and len(details) >= 3:
            objects.add(f"{descriptor} {details[0]}.{details[1]}")
        elif schema_profile and descriptor == "EXTENSION" and len(details) in (2, 3):
            objects.add(f"EXTENSION {details[1]}")
        elif schema_profile and descriptor == "TRIGGER" and len(details) == 4:
            objects.add(f"TRIGGER {details[0]}.{details[1]}.{details[2]}")
    manifest = {
        "format": MANIFEST_FORMAT,
        "purpose": "tenant_bootstrap",
        "dataPolicy": "schema_only",
        "sourceDatabase": source_database,
        "archiveSha256": archive_sha256,
        "tables": sorted(tables, key=lambda item: (item["schema"], item["table"])),
        "schemaObjectAllowlist": sorted(objects),
    }
    if schema_profile is not None:
        manifest["schemaProfile"] = schema_profile
    normalized = validate_manifest(manifest, archive_sha256, source_database)
    try:
        validate_restore_toc(toc, manifest, normalized, program_sql)
    except ManifestValidationError as error:
        # Preserve a useful private diagnosis without broadening production policy.
        return manifest, {"policyCompatible": False, "blocker": "RESTORE_TOC_POLICY_REJECTED", "detail": str(error)}, None
    status = {"policyCompatible": True, "blocker": None}
    verification = render_verification_sql(normalized)
    if schema_profile:
        from tenant_baseline_schema_profile import validate_program_sql, render_profile_verification_sql

        status["schemaProfile"] = schema_profile
        status["reviewedProgramSha256"] = validate_program_sql(program_sql)
        verification += render_profile_verification_sql()
    return manifest, status, verification


def main(argv):
    if len(argv) not in (5, 7):
        raise ValueError("Expected archive, TOC, source, output and optional schema profile/SQL")
    archive, toc_path, source, output = argv[1:5]
    directory = pathlib.Path(output)
    manifest, status, verification = compile_candidate(
        pathlib.Path(toc_path).read_text(encoding="utf-8"),
        hashlib.sha256(pathlib.Path(archive).read_bytes()).hexdigest(), source,
        schema_profile=argv[5] if len(argv) == 7 else None,
        program_sql=pathlib.Path(argv[6]).read_text(encoding="utf-8") if len(argv) == 7 else None,
    )
    with (directory / "empty-baseline.manifest.json").open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, sort_keys=True, separators=(",", ":"))
    with (directory / "schema-policy-review.json").open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(status, handle, sort_keys=True, separators=(",", ":"))
    if verification:
        with (directory / "verify-empty-baseline.sql").open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(verification)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except (OSError, ValueError, ManifestValidationError):
        print("Schema-only candidate compilation failed; no restore or approval.", file=sys.stderr)
        sys.exit(1)
