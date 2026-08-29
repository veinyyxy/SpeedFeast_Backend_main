-- Apply exactly once to the Shared Cell cell_admin database as cell_admin.
-- This table contains only immutable ownership fences and cleanup state; it
-- must never contain a Secret value, database URL, password, or tenant data.
-- The production destroy provider refuses to mutate a tenant unless every
-- column, constraint, index, trigger, object owner and effective ACL below
-- matches its compiled identity exactly.

BEGIN;

CREATE TABLE public.techlong_tenant_lifecycle_registry (
  stable_identity text COLLATE pg_catalog."C" NOT NULL,
  resource_generation bigint NOT NULL,
  ownership_marker text COLLATE pg_catalog."C" NOT NULL,
  target_database_name text COLLATE pg_catalog."C" NOT NULL,
  target_role_name text COLLATE pg_catalog."C" NOT NULL,
  provision_external_epoch bigint NOT NULL,
  provision_external_marker text COLLATE pg_catalog."C" NOT NULL,
  provision_external_operation_hash text COLLATE pg_catalog."C" NOT NULL,
  cleanup_external_epoch bigint NOT NULL,
  cleanup_external_marker text COLLATE pg_catalog."C" NOT NULL,
  cleanup_external_operation_hash text COLLATE pg_catalog."C" NOT NULL,
  lifecycle_status text COLLATE pg_catalog."C" NOT NULL,
  database_deleted boolean NOT NULL,
  role_deleted boolean NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT techlong_tenant_lifecycle_registry_pk
    PRIMARY KEY (stable_identity, resource_generation),
  CONSTRAINT techlong_tenant_lifecycle_registry_stable_identity_ck
    CHECK (stable_identity ~ '^[a-f0-9]{64}$'),
  CONSTRAINT techlong_tenant_lifecycle_registry_generation_ck
    CHECK (resource_generation > 0),
  CONSTRAINT techlong_tenant_lifecycle_registry_owner_ck
    CHECK (
      ownership_marker =
        'tl_owner_' || pg_catalog.substr(stable_identity, 1, 32) ||
        '_g' || resource_generation::text
    ),
  CONSTRAINT techlong_tenant_lifecycle_registry_names_ck
    CHECK (
      target_database_name ~ '^tenant_[a-z0-9]{1,16}_db$' AND
      target_role_name ~ '^tenant_[a-z0-9]{1,16}_role$' AND
      pg_catalog.substr(
        target_database_name, 8, pg_catalog.length(target_database_name) - 10
      ) = pg_catalog.substr(
        target_role_name, 8, pg_catalog.length(target_role_name) - 12
      )
    ),
  CONSTRAINT techlong_tenant_lifecycle_registry_provision_ck
    CHECK (
      provision_external_epoch > 0 AND
      provision_external_marker =
        'tl_epoch_' || pg_catalog.substr(stable_identity, 1, 24) ||
        '_g' || resource_generation::text ||
        '_e' || provision_external_epoch::text AND
      provision_external_operation_hash ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT techlong_tenant_lifecycle_registry_cleanup_ck
    CHECK (
      cleanup_external_epoch > provision_external_epoch AND
      cleanup_external_marker =
        'tl_epoch_' || pg_catalog.substr(stable_identity, 1, 24) ||
        '_g' || resource_generation::text ||
        '_e' || cleanup_external_epoch::text AND
      cleanup_external_operation_hash ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT techlong_tenant_lifecycle_registry_state_ck
    CHECK (
      (lifecycle_status = 'destroying' AND NOT role_deleted) OR
      (lifecycle_status = 'destroyed' AND database_deleted AND role_deleted)
    ),
  CONSTRAINT techlong_tenant_lifecycle_registry_order_ck
    CHECK (NOT role_deleted OR database_deleted)
);

REVOKE ALL ON TABLE public.techlong_tenant_lifecycle_registry FROM PUBLIC;

COMMENT ON TABLE public.techlong_tenant_lifecycle_registry IS
  'techlong-tenant-lifecycle-registry/v1;owner=cell_admin;nonsecret=true';

CREATE FUNCTION public.techlong_tenant_lifecycle_registry_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $techlong$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'tenant lifecycle tombstones cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.stable_identity,
    NEW.resource_generation,
    NEW.ownership_marker,
    NEW.target_database_name,
    NEW.target_role_name,
    NEW.provision_external_epoch,
    NEW.provision_external_marker,
    NEW.provision_external_operation_hash,
    NEW.cleanup_external_epoch,
    NEW.cleanup_external_marker,
    NEW.cleanup_external_operation_hash
  ) IS DISTINCT FROM ROW(
    OLD.stable_identity,
    OLD.resource_generation,
    OLD.ownership_marker,
    OLD.target_database_name,
    OLD.target_role_name,
    OLD.provision_external_epoch,
    OLD.provision_external_marker,
    OLD.provision_external_operation_hash,
    OLD.cleanup_external_epoch,
    OLD.cleanup_external_marker,
    OLD.cleanup_external_operation_hash
  ) THEN
    RAISE EXCEPTION 'tenant lifecycle ownership fences are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF (OLD.database_deleted AND NOT NEW.database_deleted) OR
     (OLD.role_deleted AND NOT NEW.role_deleted) OR
     OLD.lifecycle_status = 'destroyed' THEN
    RAISE EXCEPTION 'tenant lifecycle cleanup state is irreversible'
      USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$techlong$;

REVOKE ALL ON FUNCTION public.techlong_tenant_lifecycle_registry_guard()
  FROM PUBLIC;

COMMENT ON FUNCTION public.techlong_tenant_lifecycle_registry_guard() IS
  'techlong-tenant-lifecycle-registry-guard/v1;owner=cell_admin';

CREATE TRIGGER techlong_tenant_lifecycle_registry_guard_trg
BEFORE UPDATE OR DELETE ON public.techlong_tenant_lifecycle_registry
FOR EACH ROW
EXECUTE FUNCTION public.techlong_tenant_lifecycle_registry_guard();

COMMENT ON TRIGGER techlong_tenant_lifecycle_registry_guard_trg
  ON public.techlong_tenant_lifecycle_registry IS
  'techlong-tenant-lifecycle-registry-trigger/v1;irreversible=true';

CREATE TRIGGER techlong_tenant_lifecycle_registry_truncate_guard_trg
BEFORE TRUNCATE ON public.techlong_tenant_lifecycle_registry
FOR EACH STATEMENT
EXECUTE FUNCTION public.techlong_tenant_lifecycle_registry_guard();

COMMENT ON TRIGGER techlong_tenant_lifecycle_registry_truncate_guard_trg
  ON public.techlong_tenant_lifecycle_registry IS
  'techlong-tenant-lifecycle-registry-trigger/v1;irreversible=true';

REVOKE ALL ON TABLE public.techlong_tenant_lifecycle_registry FROM cell_admin;
GRANT INSERT, SELECT, UPDATE
  ON TABLE public.techlong_tenant_lifecycle_registry TO cell_admin;

COMMIT;
