import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('baseline_candidate', ROOT / 'scripts' / 'compile_tenant_baseline_candidate.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BaselineCandidateTests(unittest.TestCase):
    def compile(self, extra=''):
        return MODULE.compile_candidate('1; 0 0 SCHEMA - public owner\n2; 1259 1 TABLE public orders owner\n' + extra, 'a' * 64, 'SpeedFeast')

    def test_schema_only_candidate_reuses_strict_policy(self):
        manifest, status, sql = self.compile()
        self.assertTrue(status['policyCompatible'])
        self.assertEqual(manifest['tables'], [{'schema': 'public', 'table': 'orders', 'rows': 0}])
        self.assertIn('Row count mismatch', sql)

    def test_data_archive_is_rejected_not_labelled_empty(self):
        for descriptor in ['TABLE DATA public orders owner', 'SEQUENCE SET public orders_id_seq owner', 'BLOBS - BLOBS owner']:
            with self.assertRaises(ValueError):
                self.compile('3; 0 0 ' + descriptor + '\n')

    def test_unapproved_function_is_recorded_without_relaxing_policy(self):
        manifest, status, sql = self.compile('3; 1255 1 FUNCTION public unsafe_function() owner\n')
        self.assertFalse(status['policyCompatible'])
        self.assertEqual(status['blocker'], 'RESTORE_TOC_POLICY_REJECTED')
        self.assertIsNone(sql)
        self.assertIn('FUNCTION public.unsafe_function()', manifest['schemaObjectAllowlist'])

    def test_constraints_are_bound_to_declared_tables(self):
        _, status, _ = self.compile('3; 2606 1 CONSTRAINT public orders orders_pkey owner\n')
        self.assertTrue(status['policyCompatible'])
        _, status, _ = self.compile('3; 2606 1 CONSTRAINT public other other_pkey owner\n')
        self.assertFalse(status['policyCompatible'])


if __name__ == '__main__':
    unittest.main()
