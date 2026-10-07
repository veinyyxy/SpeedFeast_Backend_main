-- Additive completed-prepare cleanup journal. Install explicitly as cell_admin
-- after tenant_prepare_journal.sql. Never alters the legacy cleanup registry.
BEGIN;
-- The v1 owner ACL intentionally omits REFERENCES. Grant it explicitly for
-- this FK; it becomes part of the code-reviewed prepare-v2 catalog identity.
GRANT REFERENCES ON public.techlong_tenant_prepare_journal TO cell_admin;
CREATE TABLE public.techlong_tenant_normal_cleanup_journal (
  stable_identity text COLLATE pg_catalog."C" NOT NULL,
  generation bigint NOT NULL,
  hash_prefix text COLLATE pg_catalog."C" NOT NULL,
  ownership_marker text COLLATE pg_catalog."C" NOT NULL,
  database_name text COLLATE pg_catalog."C" NOT NULL,
  role_name text COLLATE pg_catalog."C" NOT NULL,
  database_oid oid NOT NULL,
  role_oid oid NOT NULL,
  provision_epoch bigint NOT NULL,
  provision_marker text COLLATE pg_catalog."C" NOT NULL,
  provision_hash text COLLATE pg_catalog."C" NOT NULL,
  cleanup_epoch bigint NOT NULL,
  cleanup_marker text COLLATE pg_catalog."C" NOT NULL,
  cleanup_hash text COLLATE pg_catalog."C" NOT NULL,
  phase text COLLATE pg_catalog."C" NOT NULL,
  database_deleted boolean NOT NULL DEFAULT false,
  role_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT techlong_normal_cleanup_pk PRIMARY KEY(stable_identity,generation),
  CONSTRAINT techlong_normal_cleanup_prepare_fk FOREIGN KEY(stable_identity,generation)
    REFERENCES public.techlong_tenant_prepare_journal(stable_identity,generation),
  CONSTRAINT techlong_normal_cleanup_identity_ck CHECK(stable_identity ~ '^[a-f0-9]{64}$' AND generation>0 AND
    hash_prefix ~ '^[a-f0-9]{32}$' AND ownership_marker='tl_owner_'||hash_prefix||'_g'||generation::text AND
    provision_epoch>0 AND cleanup_epoch>provision_epoch AND provision_hash ~ '^[a-f0-9]{64}$' AND cleanup_hash ~ '^[a-f0-9]{64}$' AND
    provision_marker='tl_epoch_'||substr(hash_prefix,1,24)||'_g'||generation::text||'_e'||provision_epoch::text AND
    cleanup_marker='tl_epoch_'||substr(hash_prefix,1,24)||'_g'||generation::text||'_e'||cleanup_epoch::text),
  CONSTRAINT techlong_normal_cleanup_names_ck CHECK(database_name ~ '^tenant_[a-z0-9]{1,16}_db$' AND
    role_name ~ '^tenant_[a-z0-9]{1,16}_role$' AND
    substr(database_name,8,length(database_name)-10)=substr(role_name,8,length(role_name)-12)),
  CONSTRAINT techlong_normal_cleanup_state_ck CHECK((phase='destroying' AND NOT role_deleted) OR
    (phase='destroyed' AND database_deleted AND role_deleted))
);
COMMENT ON TABLE public.techlong_tenant_normal_cleanup_journal IS 'techlong-normal-cleanup/v1;oid-bound=true;nonsecret=true';
REVOKE ALL ON public.techlong_tenant_normal_cleanup_journal FROM PUBLIC;
CREATE FUNCTION public.techlong_tenant_normal_cleanup_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog AS $guard$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'cleanup records are permanent' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.phase<>'destroying' OR NEW.database_deleted OR NEW.role_deleted OR NOT EXISTS(
      SELECT 1 FROM public.techlong_tenant_prepare_journal p WHERE p.stable_identity=NEW.stable_identity AND p.generation=NEW.generation
        AND p.hash_prefix=NEW.hash_prefix AND p.ownership_marker=NEW.ownership_marker AND p.database_name=NEW.database_name
        AND p.role_name=NEW.role_name AND p.database_oid=NEW.database_oid AND p.role_oid=NEW.role_oid AND p.phase='prepared'
        AND p.external_epoch=NEW.provision_epoch AND p.external_marker=NEW.provision_marker AND p.external_hash=NEW.provision_hash
        AND NOT p.database_deleted AND NOT p.role_deleted AND p.guard_deleted) THEN
      RAISE EXCEPTION 'cleanup requires exact prepared predecessor' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.stable_identity,NEW.generation,NEW.hash_prefix,NEW.ownership_marker,NEW.database_name,NEW.role_name,NEW.database_oid,NEW.role_oid,
         NEW.provision_epoch,NEW.provision_marker,NEW.provision_hash,NEW.cleanup_epoch,NEW.cleanup_marker,NEW.cleanup_hash)
    IS DISTINCT FROM ROW(OLD.stable_identity,OLD.generation,OLD.hash_prefix,OLD.ownership_marker,OLD.database_name,OLD.role_name,OLD.database_oid,OLD.role_oid,
         OLD.provision_epoch,OLD.provision_marker,OLD.provision_hash,OLD.cleanup_epoch,OLD.cleanup_marker,OLD.cleanup_hash) OR
    OLD.phase='destroyed' OR NEW.phase NOT IN ('destroying','destroyed') OR
    (OLD.database_deleted AND NOT NEW.database_deleted) OR (OLD.role_deleted AND NOT NEW.role_deleted) THEN
    RAISE EXCEPTION 'cleanup fence and terminal state are immutable' USING ERRCODE='55000';
  END IF;
  IF (NEW.database_deleted AND EXISTS(SELECT 1 FROM pg_database WHERE oid=NEW.database_oid)) OR
     (NEW.role_deleted AND EXISTS(SELECT 1 FROM pg_roles WHERE oid=NEW.role_oid)) OR
     (NEW.role_deleted AND NOT NEW.database_deleted) THEN
    RAISE EXCEPTION 'exact cleanup OIDs are not absent in deletion order' USING ERRCODE='55000';
  END IF;
  NEW.updated_at:=clock_timestamp();RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.techlong_tenant_normal_cleanup_guard() FROM PUBLIC;
COMMENT ON FUNCTION public.techlong_tenant_normal_cleanup_guard() IS 'techlong-normal-cleanup-guard/v1;permanent=true';
CREATE TRIGGER techlong_normal_cleanup_row_guard BEFORE INSERT OR UPDATE OR DELETE ON public.techlong_tenant_normal_cleanup_journal
FOR EACH ROW EXECUTE FUNCTION public.techlong_tenant_normal_cleanup_guard();
CREATE TRIGGER techlong_normal_cleanup_truncate_guard BEFORE TRUNCATE ON public.techlong_tenant_normal_cleanup_journal
FOR EACH STATEMENT EXECUTE FUNCTION public.techlong_tenant_normal_cleanup_guard();
REVOKE ALL ON public.techlong_tenant_normal_cleanup_journal FROM cell_admin;
GRANT SELECT,INSERT,UPDATE ON public.techlong_tenant_normal_cleanup_journal TO cell_admin;
COMMIT;
