import importlib.util
import json
import pathlib
import tempfile
import unittest


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[1]
VALIDATOR_PATH = REPOSITORY_ROOT / "scripts" / "render_tenant_baseline_verification.py"
SPEC = importlib.util.spec_from_file_location("tenant_baseline_validator", VALIDATOR_PATH)
VALIDATOR = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(VALIDATOR)

ARCHIVE_SHA256 = "a" * 64
SOURCE_DATABASE = "SpeedFeastTenantBaseline"


def manifest(*, policy="schema_only", tables=None, **overrides):
    value = {
        "format": "speedfeast-database-migration-manifest/v1",
        "purpose": "tenant_bootstrap",
        "dataPolicy": policy,
        "sourceDatabase": SOURCE_DATABASE,
        "archiveSha256": ARCHIVE_SHA256,
        "tables": tables
        or [
            {"schema": "public", "table": "Users", "rows": 0},
            {"schema": "public", "table": "Order", "rows": 0},
            {"schema": "public", "table": "merchant_permissions", "rows": 0},
        ],
    }
    value.update(overrides)
    return value


def safe_toc(table_names=("Users", "Order", "merchant_permissions")):
    lines = ["; synthetic pg_restore list", "1; 0 0 SCHEMA - public owner"]
    for offset, table_name in enumerate(table_names, start=10):
        lines.append(f"{offset}; 1259 {offset} TABLE public {table_name} owner")
    return "\n".join(lines) + "\n"


class TenantBaselineManifestTests(unittest.TestCase):
    def validate(self, value):
        return VALIDATOR.validate_manifest(value, ARCHIVE_SHA256, SOURCE_DATABASE)

    def test_schema_only_manifest_with_zero_rows_is_accepted(self):
        normalized = self.validate(manifest())
        self.assertEqual(len(normalized), 3)
        self.assertTrue(all(rows == 0 for _, _, rows in normalized))

    def test_generic_export_without_tenant_purpose_is_rejected(self):
        value = manifest()
        value.pop("purpose")
        with self.assertRaisesRegex(
            VALIDATOR.ManifestValidationError,
            "purpose must be tenant_bootstrap",
        ):
            self.validate(value)

    def test_archive_digest_is_cryptographically_bound_to_the_manifest(self):
        with self.assertRaisesRegex(
            VALIDATOR.ManifestValidationError,
            "archiveSha256 does not match",
        ):
            VALIDATOR.validate_manifest(manifest(), "b" * 64, SOURCE_DATABASE)

    def test_real_customer_and_order_rows_are_always_rejected(self):
        value = manifest(
            tables=[
                {"schema": "public", "table": "Order", "rows": 115},
                {"schema": "public", "table": "Users", "rows": 5},
            ]
        )
        with self.assertRaisesRegex(
            VALIDATOR.ManifestValidationError,
            "sensitive business tables must have zero rows",
        ):
            self.validate(value)

    def test_code_approved_reference_seeds_can_be_explicitly_allowlisted(self):
        value = manifest(
            policy="allowlisted_seed_tables",
            seedTableAllowlist=[
                "public.merchant_permissions",
                "public.merchant_role_permissions",
            ],
            tables=[
                {"schema": "public", "table": "Users", "rows": 0},
                {"schema": "public", "table": "merchant_permissions", "rows": 12},
                {
                    "schema": "public",
                    "table": "merchant_role_permissions",
                    "rows": 8,
                },
            ],
        )
        normalized = self.validate(value)
        self.assertEqual(sum(rows for _, _, rows in normalized), 20)

    def test_manifest_cannot_allowlist_an_unapproved_business_table(self):
        value = manifest(
            policy="allowlisted_seed_tables",
            seedTableAllowlist=["public.products"],
            tables=[{"schema": "public", "table": "products", "rows": 3}],
        )
        with self.assertRaisesRegex(
            VALIDATOR.ManifestValidationError,
            "not approved by application policy",
        ):
            self.validate(value)

    def test_rows_outside_the_declared_seed_allowlist_are_rejected(self):
        value = manifest(
            policy="allowlisted_seed_tables",
            seedTableAllowlist=["public.merchant_permissions"],
            tables=[
                {"schema": "public", "table": "merchant_permissions", "rows": 12},
                {"schema": "public", "table": "system_config", "rows": 1},
            ],
        )
        with self.assertRaisesRegex(
            VALIDATOR.ManifestValidationError,
            "outside seedTableAllowlist",
        ):
            self.validate(value)

    def test_restore_toc_accepts_only_declared_schema_objects(self):
        value = manifest()
        normalized = self.validate(value)
        VALIDATOR.validate_restore_toc(safe_toc(), value, normalized)

    def test_restore_toc_has_a_bounded_entry_count(self):
        value = manifest()
        normalized = self.validate(value)
        original_limit = VALIDATOR.MAX_RESTORE_TOC_ENTRIES
        try:
            VALIDATOR.MAX_RESTORE_TOC_ENTRIES = 3
            with self.assertRaisesRegex(
                VALIDATOR.ManifestValidationError,
                "maximum approved entry count",
            ):
                VALIDATOR.validate_restore_toc(safe_toc(), value, normalized)
        finally:
            VALIDATOR.MAX_RESTORE_TOC_ENTRIES = original_limit

    def test_restore_toc_requires_each_schema_object_in_the_manifest_allowlist(self):
        value = manifest(
            schemaObjectAllowlist=[
                "SEQUENCE public.Users_id_seq",
                "DEFAULT public.Users.id",
                "CONSTRAINT public.Users.Users_pkey",
                "FK CONSTRAINT public.Order.Order_user_id_fkey",
                "INDEX public.idx_users_phone",
                "FUNCTION public.default_store_id()",
            ]
        )
        normalized = self.validate(value)
        toc = safe_toc()
        toc += "20; 1259 20 SEQUENCE public Users_id_seq owner\n"
        toc += "21; 0 20 SEQUENCE OWNED BY public Users_id_seq owner\n"
        toc += "22; 2604 22 DEFAULT public Users id owner\n"
        toc += "23; 2606 23 CONSTRAINT public Users Users_pkey owner\n"
        toc += "24; 2606 24 FK CONSTRAINT public Order Order_user_id_fkey owner\n"
        toc += "25; 1259 25 INDEX public idx_users_phone owner\n"
        toc += "26; 1255 26 FUNCTION public default_store_id() owner\n"
        VALIDATOR.validate_restore_toc(toc, value, normalized)

        with self.assertRaisesRegex(
            VALIDATOR.ManifestValidationError,
            "not approved by the manifest",
        ):
            VALIDATOR.validate_restore_toc(
                safe_toc() + "27; 1259 27 INDEX public unexpected_index owner\n",
                manifest(),
                self.validate(manifest()),
            )

    def test_restore_toc_allows_table_data_only_for_an_approved_seed(self):
        value = manifest(
            policy="allowlisted_seed_tables",
            seedTableAllowlist=["public.merchant_permissions"],
            tables=[
                {"schema": "public", "table": "Users", "rows": 0},
                {"schema": "public", "table": "merchant_permissions", "rows": 12},
            ],
        )
        normalized = self.validate(value)
        toc = safe_toc(("Users", "merchant_permissions"))
        toc += "30; 0 30 TABLE DATA public merchant_permissions owner\n"
        VALIDATOR.validate_restore_toc(toc, value, normalized)

        with self.assertRaisesRegex(
            VALIDATOR.ManifestValidationError,
            "TABLE DATA is forbidden",
        ):
            VALIDATOR.validate_restore_toc(
                toc + "31; 0 31 TABLE DATA public Users owner\n",
                value,
                normalized,
            )

    def test_restore_toc_rejects_dangerous_object_types(self):
        value = manifest()
        normalized = self.validate(value)
        dangerous_entries = [
            "EXTENSION - uuid-ossp owner",
            "BLOBS - BLOBS owner",
            "ACL public TABLE Users owner",
            "SECURITY LABEL public TABLE Users owner",
            "EVENT TRIGGER - tenant_escape owner",
            "FOREIGN DATA WRAPPER - remote owner",
            "FOREIGN SERVER - remote owner",
            "USER MAPPING - remote owner",
            "TRIGGER public Users unsafe owner",
            "RULE public Users unsafe owner",
        ]
        for offset, dangerous_entry in enumerate(dangerous_entries, start=100):
            with self.subTest(dangerous_entry=dangerous_entry):
                with self.assertRaisesRegex(
                    VALIDATOR.ManifestValidationError,
                    "forbidden",
                ):
                    VALIDATOR.validate_restore_toc(
                        safe_toc() + f"{offset}; 0 {offset} {dangerous_entry}\n",
                        value,
                        normalized,
                    )

    def test_restore_toc_rejects_unapproved_functions_and_unknown_entries(self):
        value = manifest()
        normalized = self.validate(value)
        with self.assertRaisesRegex(
            VALIDATOR.ManifestValidationError,
            "FUNCTION is not approved",
        ):
            VALIDATOR.validate_restore_toc(
                safe_toc() + "200; 0 200 FUNCTION public escape_tenant() owner\n",
                value,
                normalized,
            )
        with self.assertRaisesRegex(
            VALIDATOR.ManifestValidationError,
            "unknown or unapproved",
        ):
            VALIDATOR.validate_restore_toc(
                safe_toc() + "201; 0 201 EXECUTE SOMETHING unsafe owner\n",
                value,
                normalized,
            )

    def test_cli_writes_verification_sql_only_for_an_accepted_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            directory_path = pathlib.Path(directory)
            manifest_path = directory_path / "baseline.manifest.json"
            toc_path = directory_path / "baseline.toc"
            output_path = directory_path / "verify.sql"
            manifest_path.write_text(json.dumps(manifest()), encoding="utf-8")
            toc_path.write_text(safe_toc(), encoding="utf-8")

            exit_code = VALIDATOR.main(
                [
                    str(VALIDATOR_PATH),
                    str(manifest_path),
                    ARCHIVE_SHA256,
                    SOURCE_DATABASE,
                    str(toc_path),
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 0)
            rendered = output_path.read_text(encoding="utf-8")
            self.assertIn("Restored table set differs from the manifest", rendered)
            self.assertIn('FROM "public"."Users"', rendered)


if __name__ == "__main__":
    unittest.main()
