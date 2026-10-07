-- Code-reviewed additive journal; install once in cell_admin as cell_admin.
-- No secrets, URLs, passwords or business data. Never alter the old cleanup
-- registry implicitly. The prepare provider verifies the complete catalog.
BEGIN;
CREATE TABLE public.techlong_tenant_prepare_journal (
  stable_identity text COLLATE pg_catalog."C" NOT NULL,
  hash_prefix text COLLATE pg_catalog."C" NOT NULL,
  generation bigint NOT NULL,
  ownership_marker text COLLATE pg_catalog."C" NOT NULL,
  external_epoch bigint NOT NULL,
  external_marker text COLLATE pg_catalog."C" NOT NULL,
  external_hash text COLLATE pg_catalog."C" NOT NULL,
  database_name text COLLATE pg_catalog."C" NOT NULL,
  role_name text COLLATE pg_catalog."C" NOT NULL,
  nonce text COLLATE pg_catalog."C" NOT NULL,
  guard_name text COLLATE pg_catalog."C" NOT NULL,
  guard_oid oid NOT NULL,
  role_oid oid NOT NULL,
  database_oid oid,
  phase text COLLATE pg_catalog."C" NOT NULL,
  database_deleted boolean NOT NULL DEFAULT false,
  role_deleted boolean NOT NULL DEFAULT false,
  guard_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT techlong_prepare_pk PRIMARY KEY (stable_identity, generation),
  CONSTRAINT techlong_prepare_identity_ck CHECK (
    stable_identity ~ '^[a-f0-9]{64}$' AND hash_prefix ~ '^[a-f0-9]{32}$' AND generation > 0 AND
    ownership_marker = 'tl_owner_' || hash_prefix || '_g' || generation::text AND
    external_epoch > 0 AND external_hash ~ '^[a-f0-9]{64}$' AND
    external_marker = 'tl_epoch_' || substr(hash_prefix,1,24) || '_g' || generation::text || '_e' || external_epoch::text),
  CONSTRAINT techlong_prepare_names_ck CHECK (
    database_name ~ '^tenant_[a-z0-9]{1,16}_db$' AND role_name ~ '^tenant_[a-z0-9]{1,16}_role$' AND
    substr(database_name,8,length(database_name)-10) = substr(role_name,8,length(role_name)-12) AND
    nonce ~ '^[a-f0-9]{32}$' AND guard_name = 'tl_prepare_' || nonce),
  CONSTRAINT techlong_prepare_phase_ck CHECK (
    phase IN ('reserved','create_submitted','catalog_bound','prepared','compensating','compensated') AND
    (phase NOT IN ('catalog_bound','prepared') OR database_oid IS NOT NULL) AND
    (phase <> 'prepared' OR (NOT database_deleted AND NOT role_deleted AND guard_deleted)) AND
    (phase <> 'compensated' OR (database_deleted AND role_deleted AND guard_deleted)))
);
CREATE UNIQUE INDEX techlong_prepare_database_active ON public.techlong_tenant_prepare_journal(database_name)
  WHERE phase <> 'compensated';
CREATE UNIQUE INDEX techlong_prepare_role_active ON public.techlong_tenant_prepare_journal(role_name)
  WHERE phase <> 'compensated';
COMMENT ON TABLE public.techlong_tenant_prepare_journal IS 'techlong-tenant-prepare-journal/v1;nonsecret=true';
REVOKE ALL ON public.techlong_tenant_prepare_journal FROM PUBLIC;
CREATE FUNCTION public.techlong_tenant_prepare_journal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $guard$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'prepare journal records are permanent' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.stable_identity,NEW.hash_prefix,NEW.generation,NEW.ownership_marker,NEW.external_epoch,
         NEW.external_marker,NEW.external_hash,NEW.database_name,NEW.role_name,NEW.nonce,NEW.guard_name,NEW.guard_oid,NEW.role_oid)
     IS DISTINCT FROM
     ROW(OLD.stable_identity,OLD.hash_prefix,OLD.generation,OLD.ownership_marker,OLD.external_epoch,
         OLD.external_marker,OLD.external_hash,OLD.database_name,OLD.role_name,OLD.nonce,OLD.guard_name,OLD.guard_oid,OLD.role_oid)
     OR (OLD.database_oid IS NOT NULL AND NEW.database_oid IS DISTINCT FROM OLD.database_oid) THEN
    RAISE EXCEPTION 'prepare identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.phase IN ('prepared','compensated') OR
    NOT (NEW.phase=OLD.phase OR
      (OLD.phase='reserved' AND NEW.phase IN ('create_submitted','compensating')) OR
      (OLD.phase='create_submitted' AND NEW.phase IN ('catalog_bound','compensating')) OR
      (OLD.phase='catalog_bound' AND NEW.phase IN ('prepared','compensating')) OR
      (OLD.phase='compensating' AND NEW.phase='compensated')) OR
    (OLD.database_deleted AND NOT NEW.database_deleted) OR
    (OLD.role_deleted AND NOT NEW.role_deleted) OR
    (OLD.guard_deleted AND NOT NEW.guard_deleted) THEN
    RAISE EXCEPTION 'prepare state is irreversible' USING ERRCODE='55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.techlong_tenant_prepare_journal_guard() FROM PUBLIC;
COMMENT ON FUNCTION public.techlong_tenant_prepare_journal_guard() IS 'techlong-prepare-guard/v1;irreversible=true';
CREATE TRIGGER techlong_prepare_row_guard BEFORE UPDATE OR DELETE ON public.techlong_tenant_prepare_journal
FOR EACH ROW EXECUTE FUNCTION public.techlong_tenant_prepare_journal_guard();
CREATE TRIGGER techlong_prepare_truncate_guard BEFORE TRUNCATE ON public.techlong_tenant_prepare_journal
FOR EACH STATEMENT EXECUTE FUNCTION public.techlong_tenant_prepare_journal_guard();
REVOKE ALL ON public.techlong_tenant_prepare_journal FROM cell_admin;
GRANT SELECT,INSERT,UPDATE ON public.techlong_tenant_prepare_journal TO cell_admin;
COMMIT;
