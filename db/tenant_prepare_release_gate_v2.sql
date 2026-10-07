-- Explicit upgrade, not automatic migration. Require the exact v1 catalog
-- readback before applying and the exact v2 readback afterwards. Install the
-- normal cleanup journal first. No row update/delete, no original registry edit.
-- Completed prepare rows remain permanent/immutable. Code v2 additionally
-- requires their exact destroyed cleanup tombstone before namespace reuse.
BEGIN;
DROP INDEX public.techlong_prepare_database_active;
DROP INDEX public.techlong_prepare_role_active;
CREATE UNIQUE INDEX techlong_prepare_database_active ON public.techlong_tenant_prepare_journal(database_name)
  WHERE phase NOT IN ('prepared','compensated');
CREATE UNIQUE INDEX techlong_prepare_role_active ON public.techlong_tenant_prepare_journal(role_name)
  WHERE phase NOT IN ('prepared','compensated');
COMMENT ON TABLE public.techlong_tenant_prepare_journal IS 'techlong-tenant-prepare-journal/v2;release-tombstone-required=true;nonsecret=true';
COMMIT;
