import pathlib
import json
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from compile_tenant_baseline_candidate import compile_candidate
from render_tenant_baseline_verification import ManifestValidationError
from render_tenant_baseline_verification import main as verify_main
from tenant_baseline_schema_profile import PROFILE, PROGRAMS, REQUIRED_TABLES, TABLE_SETTINGS, validate_program_sql


def fixture():
    sql, toc = [], ['1; 0 0 SCHEMA - public owner']
    for index, table in enumerate(sorted(REQUIRED_TABLES), 10):
        toc.append(f'{index}; 1259 {index} TABLE public {table} owner')
    for index, (key, definition) in enumerate(PROGRAMS.items(), 30):
        descriptor, value = key.split(' ', 1)
        if descriptor == 'EXTENSION':
            name, schema, details = value, '-', f'- {value}'
        elif descriptor == 'FUNCTION':
            schema, name = value.split('.', 1)
            details = f'{schema} {name}'
        else:
            schema, table, trigger = value.split('.')
            name, details = f'{table} {trigger}', f'{schema} {table} {trigger}'
        sql.append(f'--\n-- Name: {name}; Type: {descriptor}; Schema: {schema}; Owner: -\n--\n\n{definition}\n\n')
        toc.append(f'{index}; 0 {index} {descriptor} {details} owner')
    sql.append('--\n-- Name: cart; Type: TABLE; Schema: public; Owner: -\n--\nCREATE TABLE public.cart();\n')
    return '\n'.join(toc), ''.join(sql)


class BaselineProfileTests(unittest.TestCase):
    def compile(self, toc=None, sql=None, profile=PROFILE):
        original_toc, original_sql = fixture()
        return compile_candidate(toc or original_toc, 'a' * 64, 'SpeedFeast',
                                 schema_profile=profile, program_sql=sql or original_sql)

    def test_exact_profile_compiles_and_includes_installed_object_checks(self):
        manifest, status, sql = self.compile()
        self.assertTrue(status['policyCompatible'])
        self.assertEqual(manifest['schemaProfile'], PROFILE)
        self.assertEqual(len(status['reviewedProgramSha256']), 10)
        self.assertIn("e.extversion='1.1'", sql)
        self.assertIn('NOT p.prosecdef', sql)
        self.assertIn('t.tgtype=29', sql)
        self.assertIn('Row count mismatch', sql)

    def test_profile_never_implicitly_activates_for_legacy_manifest(self):
        _, status, verification = self.compile(profile=None)
        self.assertFalse(status['policyCompatible'])
        self.assertIsNone(verification)

    def test_pg_dump_extension_may_have_no_owner_field(self):
        toc, _ = fixture()
        _, status, _ = self.compile(toc=toc.replace('EXTENSION - uuid-ossp owner', 'EXTENSION - uuid-ossp'))
        self.assertTrue(status['policyCompatible'])

    def test_independent_cli_has_byte_identical_verification_output(self):
        manifest, _, expected = self.compile()
        toc, sql = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            (root / 'toc.txt').write_text(toc, encoding='utf-8')
            (root / 'schema.sql').write_text(sql, encoding='utf-8')
            result = verify_main(['verify', str(root / 'manifest.json'), 'a' * 64,
                                  'SpeedFeast', str(root / 'toc.txt'), str(root / 'verify.sql'), str(root / 'schema.sql')])
            self.assertEqual(result, 0)
            self.assertEqual((root / 'verify.sql').read_bytes(), expected.encode('utf-8'))

    def test_definition_changes_or_extra_statements_are_rejected(self):
        _, sql = fixture()
        changes = [sql.replace('NEW.updated_at = now()', "NEW.updated_at = '2000-01-01'"),
                   sql.replace('LANGUAGE plpgsql', 'LANGUAGE plpgsql SECURITY DEFINER', 1),
                   sql.replace('END;\n$$;', 'END;\n$$;\nSELECT pg_sleep(1);', 1),
                   sql.replace('AFTER INSERT OR DELETE OR UPDATE', 'AFTER INSERT'),
                   sql.replace('WITH SCHEMA public', 'WITH SCHEMA other')]
        for changed in changes:
            _, status, verification = self.compile(sql=changed)
            self.assertFalse(status['policyCompatible'])
            self.assertIsNone(verification)

    def test_missing_duplicate_or_unknown_sql_objects_are_rejected(self):
        _, sql = fixture()
        duplicate = sql[:sql.index('--\n-- Name: default_saas_instance_id')]
        changes = [sql.replace('Type: EXTENSION', 'Type: COMMENT', 1),
                   duplicate + sql, sql.replace('Name: set_updated_at()', 'Name: unknown()')]
        for changed in changes:
            with self.assertRaises(ValueError):
                validate_program_sql(changed)

    def test_unknown_or_duplicate_toc_objects_still_fail_closed(self):
        toc, _ = fixture()
        for extra in ['EXTENSION - dblink owner', 'FUNCTION public escape_tenant() owner',
                      'TRIGGER public cart unreviewed owner', 'EVENT TRIGGER - escaped owner',
                      'ACL public TABLE cart owner', 'FUNCTION public set_updated_at() owner']:
            _, status, _ = self.compile(toc=toc + '\n99; 0 99 ' + extra)
            self.assertFalse(status['policyCompatible'])

    def test_missing_toc_program_or_referenced_table_is_rejected(self):
        toc, _ = fixture()
        _, status, _ = self.compile(toc='\n'.join(line for line in toc.splitlines() if 'FUNCTION public set_updated_at()' not in line))
        self.assertFalse(status['policyCompatible'])
        with self.assertRaises(ManifestValidationError):
            self.compile(toc='\n'.join(line for line in toc.splitlines() if 'TABLE public cartitem ' not in line))

    def test_offline_sql_required_and_unknown_profile_rejected(self):
        toc, _ = fixture()
        _, status, _ = compile_candidate(toc, 'a' * 64, 'SpeedFeast', schema_profile=PROFILE)
        self.assertFalse(status['policyCompatible'])
        with self.assertRaises(ManifestValidationError):
            self.compile(profile='unreviewed')

    def test_line_endings_and_only_known_table_settings_are_tolerated(self):
        _, sql = fixture()
        self.assertEqual(len(validate_program_sql(sql.replace('\n', '\r\n'))), 10)
        modified = sql.replace(PROGRAMS['FUNCTION public.set_updated_at()'], PROGRAMS['FUNCTION public.set_updated_at()'] + '\n\n' + TABLE_SETTINGS)
        self.assertEqual(len(validate_program_sql(modified)), 10)
        with self.assertRaises(ValueError):
            validate_program_sql(modified.replace('heap;', 'heap;\nSELECT 1;'))


if __name__ == '__main__':
    unittest.main()
