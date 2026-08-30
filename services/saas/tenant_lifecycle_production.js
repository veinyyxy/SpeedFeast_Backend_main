const fs = require('node:fs');

const {
  SECRET_KEYS,
  TenantLifecycleContractError,
  assertMarkerShape,
  assertRuntimeSecret,
  canonicalJson,
} = require('./tenant_lifecycle_service');
const {
  AwsSdkTenantLifecycleReceiptObjectStore,
  TenantLifecycleReceiptPublisher,
} = require('./tenant_lifecycle_receipt_publisher');

const TENANT_LIFECYCLE_INSPECT_RUNTIME_MODE =
  'aws_sandbox_tenant_lifecycle_inspect';
const TENANT_LIFECYCLE_DESTROY_RUNTIME_MODE =
  'aws_sandbox_tenant_lifecycle_destroy';
const TENANT_LIFECYCLE_RUNTIME_MODE = TENANT_LIFECYCLE_INSPECT_RUNTIME_MODE;
const PRODUCTION_RUNTIME_MODE_BY_OPERATION = Object.freeze({
  inspect: TENANT_LIFECYCLE_INSPECT_RUNTIME_MODE,
  destroy: TENANT_LIFECYCLE_DESTROY_RUNTIME_MODE,
});
const RDS_CA_BUNDLE_PATH =
  '/usr/local/share/ca-certificates/aws-rds-global-bundle.pem';
const TENANT_LIFECYCLE_DEADLINE_MS = 120_000;
const MAX_SECRET_BYTES = 65_536;
const MAX_DATABASE_METADATA_BYTES = 8_192;
const POSTGRES_CLEANUP_TIMEOUT_MS = 1_000;
const TENANT_LIFECYCLE_REGISTRY_TABLE =
  'public.techlong_tenant_lifecycle_registry';
const TENANT_LIFECYCLE_REGISTRY_COMMENT =
  'techlong-tenant-lifecycle-registry/v1;owner=cell_admin;nonsecret=true';
const TENANT_LIFECYCLE_REGISTRY_COLUMNS = Object.freeze([
  'stable_identity',
  'resource_generation',
  'ownership_marker',
  'target_database_name',
  'target_role_name',
  'provision_external_epoch',
  'provision_external_marker',
  'provision_external_operation_hash',
  'cleanup_external_epoch',
  'cleanup_external_marker',
  'cleanup_external_operation_hash',
  'lifecycle_status',
  'database_deleted',
  'role_deleted',
  'updated_at',
]);
const TENANT_LIFECYCLE_REGISTRY_COLUMN_IDENTITIES = Object.freeze([
  ['stable_identity', 'text', true, null],
  ['resource_generation', 'bigint', true, null],
  ['ownership_marker', 'text', true, null],
  ['target_database_name', 'text', true, null],
  ['target_role_name', 'text', true, null],
  ['provision_external_epoch', 'bigint', true, null],
  ['provision_external_marker', 'text', true, null],
  ['provision_external_operation_hash', 'text', true, null],
  ['cleanup_external_epoch', 'bigint', true, null],
  ['cleanup_external_marker', 'text', true, null],
  ['cleanup_external_operation_hash', 'text', true, null],
  ['lifecycle_status', 'text', true, null],
  ['database_deleted', 'boolean', true, null],
  ['role_deleted', 'boolean', true, null],
  ['updated_at', 'timestamp with time zone', true, 'clock_timestamp()'],
].map(([name, dataType, notNull, defaultExpression], index) => Object.freeze({
  position: index + 1,
  name,
  dataType,
  notNull,
  defaultExpression,
  identity: '',
  generated: '',
  hasColumnAcl: false,
  columnAcl: Object.freeze([]),
  collation: dataType === 'text'
    ? Object.freeze({ schema: 'pg_catalog', name: 'C' })
    : null,
  isLocal: true,
  inheritanceCount: 0,
  hasMissing: false,
})));
const TENANT_LIFECYCLE_REGISTRY_CONSTRAINT_IDENTITIES = Object.freeze([
  {
    name: 'techlong_tenant_lifecycle_registry_cleanup_ck',
    type: 'c',
    columns: [
      'cleanup_external_epoch',
      'provision_external_epoch',
      'cleanup_external_marker',
      'stable_identity',
      'resource_generation',
      'cleanup_external_operation_hash',
    ],
    definition: "CHECK (((cleanup_external_epoch > provision_external_epoch) AND (cleanup_external_marker = ((((('tl_epoch_'::text || substr(stable_identity, 1, 24)) || '_g'::text) || (resource_generation)::text) || '_e'::text) || (cleanup_external_epoch)::text)) AND (cleanup_external_operation_hash ~ '^[a-f0-9]{64}$'::text)))",
  },
  {
    name: 'techlong_tenant_lifecycle_registry_generation_ck',
    type: 'c',
    columns: ['resource_generation'],
    definition: 'CHECK ((resource_generation > 0))',
  },
  {
    name: 'techlong_tenant_lifecycle_registry_names_ck',
    type: 'c',
    columns: ['target_database_name', 'target_role_name'],
    definition: "CHECK (((target_database_name ~ '^tenant_[a-z0-9]{1,16}_db$'::text) AND (target_role_name ~ '^tenant_[a-z0-9]{1,16}_role$'::text) AND (substr(target_database_name, 8, (length(target_database_name) - 10)) = substr(target_role_name, 8, (length(target_role_name) - 12)))))",
  },
  {
    name: 'techlong_tenant_lifecycle_registry_order_ck',
    type: 'c',
    columns: ['role_deleted', 'database_deleted'],
    definition: 'CHECK (((NOT role_deleted) OR database_deleted))',
  },
  {
    name: 'techlong_tenant_lifecycle_registry_owner_ck',
    type: 'c',
    columns: ['ownership_marker', 'stable_identity', 'resource_generation'],
    definition: "CHECK ((ownership_marker = ((('tl_owner_'::text || substr(stable_identity, 1, 32)) || '_g'::text) || (resource_generation)::text)))",
  },
  {
    name: 'techlong_tenant_lifecycle_registry_pk',
    type: 'p',
    columns: ['stable_identity', 'resource_generation'],
    noInherit: true,
    definition: 'PRIMARY KEY (stable_identity, resource_generation)',
  },
  {
    name: 'techlong_tenant_lifecycle_registry_provision_ck',
    type: 'c',
    columns: [
      'provision_external_epoch',
      'provision_external_marker',
      'stable_identity',
      'resource_generation',
      'provision_external_operation_hash',
    ],
    definition: "CHECK (((provision_external_epoch > 0) AND (provision_external_marker = ((((('tl_epoch_'::text || substr(stable_identity, 1, 24)) || '_g'::text) || (resource_generation)::text) || '_e'::text) || (provision_external_epoch)::text)) AND (provision_external_operation_hash ~ '^[a-f0-9]{64}$'::text)))",
  },
  {
    name: 'techlong_tenant_lifecycle_registry_stable_identity_ck',
    type: 'c',
    columns: ['stable_identity'],
    definition: "CHECK ((stable_identity ~ '^[a-f0-9]{64}$'::text))",
  },
  {
    name: 'techlong_tenant_lifecycle_registry_state_ck',
    type: 'c',
    columns: ['lifecycle_status', 'role_deleted', 'database_deleted'],
    definition: "CHECK ((((lifecycle_status = 'destroying'::text) AND (NOT role_deleted)) OR ((lifecycle_status = 'destroyed'::text) AND database_deleted AND role_deleted)))",
  },
].map((identity) => Object.freeze({
  name: identity.name,
  type: identity.type,
  validated: true,
  deferrable: false,
  deferred: false,
  noInherit: identity.noInherit === true,
  isLocal: true,
  inheritanceCount: 0,
  parentConstraintOid: '0',
  columns: Object.freeze(identity.columns),
  definition: identity.definition,
})));
const TENANT_LIFECYCLE_REGISTRY_INDEX_IDENTITIES = Object.freeze([
  Object.freeze({
    name: 'techlong_tenant_lifecycle_registry_pk',
    accessMethod: 'btree',
    unique: true,
    primary: true,
    exclusion: false,
    immediate: true,
    clustered: false,
    valid: true,
    ready: true,
    live: true,
    replicaIdentity: false,
    keyColumns: Object.freeze(['stable_identity', 'resource_generation']),
    includedColumns: Object.freeze([]),
    predicate: null,
    expressions: null,
    definition: 'CREATE UNIQUE INDEX techlong_tenant_lifecycle_registry_pk ON public.techlong_tenant_lifecycle_registry USING btree (stable_identity, resource_generation)',
  }),
]);
const TENANT_LIFECYCLE_REGISTRY_GUARD_COMMENT =
  'techlong-tenant-lifecycle-registry-guard/v1;owner=cell_admin';
const TENANT_LIFECYCLE_REGISTRY_TRIGGER_COMMENT =
  'techlong-tenant-lifecycle-registry-trigger/v1;irreversible=true';
const TENANT_LIFECYCLE_REGISTRY_GUARD_SOURCE = `BEGIN
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
END;`;
const MANAGEMENT_SECRET_KEYS = Object.freeze(['password', 'username']);
const DATABASE_METADATA_KEYS = Object.freeze([
  'kind',
  'marker',
  'ownershipMarker',
  'schemaVersion',
]);
const DATABASE_METADATA_KINDS = Object.freeze({
  database: 'techlong_tenant_database',
  role: 'techlong_tenant_role',
});
const PG_STARTUP_OPTIONS =
  '-c default_transaction_read_only=on ' +
  '-c statement_timeout=5000 ' +
  '-c lock_timeout=1000 ' +
  '-c idle_in_transaction_session_timeout=10000 ' +
  '-c search_path=pg_catalog';
const PG_DESTROY_STARTUP_OPTIONS =
  '-c default_transaction_read_only=off ' +
  '-c statement_timeout=15000 ' +
  '-c lock_timeout=5000 ' +
  '-c idle_in_transaction_session_timeout=15000 ' +
  '-c search_path=pg_catalog';

const FORBIDDEN_AWS_ENVIRONMENT = Object.freeze([
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'AWS_ENDPOINT_URL_SECRETS_MANAGER',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CA_BUNDLE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
]);
const ALLOWED_PG_ENVIRONMENT = Object.freeze({
  PGSSLMODE: 'verify-full',
  PGSSL_REJECT_UNAUTHORIZED: 'true',
  PGSSLROOTCERT: RDS_CA_BUNDLE_PATH,
});

const INSPECT_IDENTITY_SQL = `
SELECT
  current_database() AS management_database,
  current_user AS management_username,
  pg_catalog.inet_server_port() AS management_port,
  pg_catalog.current_setting('default_transaction_read_only') AS read_only,
  COALESCE((
    SELECT ssl
    FROM pg_catalog.pg_stat_ssl
    WHERE pid = pg_catalog.pg_backend_pid()
  ), false) AS tls_active
`;

const INSPECT_RESOURCES_SQL = `
WITH target_database AS (
  SELECT pg_catalog.shobj_description(oid, 'pg_database') AS metadata
  FROM pg_catalog.pg_database
  WHERE datname = $1
), target_role AS (
  SELECT pg_catalog.shobj_description(oid, 'pg_authid') AS metadata
  FROM pg_catalog.pg_roles
  WHERE rolname = $2
)
SELECT
  EXISTS (SELECT 1 FROM target_database) AS database_exists,
  (
    SELECT CASE
      WHEN pg_catalog.octet_length(metadata) <= ${MAX_DATABASE_METADATA_BYTES}
        THEN metadata
      ELSE NULL
    END
    FROM target_database
  ) AS database_comment,
  COALESCE((
    SELECT pg_catalog.octet_length(metadata) FROM target_database
  ), 0) AS database_comment_bytes,
  COALESCE((
    SELECT pg_catalog.octet_length(metadata) > ${MAX_DATABASE_METADATA_BYTES}
    FROM target_database
  ), false) AS database_comment_too_large,
  EXISTS (SELECT 1 FROM target_role) AS role_exists,
  (
    SELECT CASE
      WHEN pg_catalog.octet_length(metadata) <= ${MAX_DATABASE_METADATA_BYTES}
        THEN metadata
      ELSE NULL
    END
    FROM target_role
  ) AS role_comment,
  COALESCE((
    SELECT pg_catalog.octet_length(metadata) FROM target_role
  ), 0) AS role_comment_bytes,
  COALESCE((
    SELECT pg_catalog.octet_length(metadata) > ${MAX_DATABASE_METADATA_BYTES}
    FROM target_role
  ), false) AS role_comment_too_large
`;

const DESTROY_ADVISORY_LOCK_SQL = `
SELECT pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended($1::text, 0)
) AS locked
`;
const DESTROY_REGISTRY_IDENTITY_SQL = `
WITH target_table AS (
  SELECT c.*
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'techlong_tenant_lifecycle_registry'
), guard_trigger AS (
  SELECT
    t.oid AS trigger_oid,
    t.tgname,
    t.tgenabled,
    t.tgtype,
    t.tgisinternal,
    t.tgnargs,
    t.tgattr,
    t.tgqual,
    t.tgparentid,
    t.tgconstraint,
    t.tgconstrrelid,
    t.tgconstrindid,
    t.tgdeferrable,
    t.tginitdeferred,
    t.tgoldtable,
    t.tgnewtable,
    p.oid AS function_oid,
    p.proname,
    p.proowner,
    p.prosecdef,
    p.proleakproof,
    p.proisstrict,
    p.proretset,
    p.prokind,
    p.provolatile,
    p.proparallel,
    p.pronargs,
    p.proconfig,
    p.prosrc,
    pn.nspname AS function_schema,
    l.lanname AS function_language,
    pg_catalog.format_type(p.prorettype, NULL) AS function_result
  FROM target_table AS c
  JOIN pg_catalog.pg_trigger AS t ON t.tgrelid = c.oid
  JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
  JOIN pg_catalog.pg_namespace AS pn ON pn.oid = p.pronamespace
  JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
  WHERE NOT t.tgisinternal
)
SELECT
  c.relkind,
  c.relpersistence AS persistence,
  c.relreplident AS replica_identity,
  c.relispartition AS is_partition,
  c.reloftype = 0 AS has_no_typed_table,
  c.relhasrules AS has_rules,
  c.relhassubclass AS has_subclass,
  c.relnatts AS attribute_count,
  (
    SELECT pg_catalog.count(*)::integer
    FROM pg_catalog.pg_attribute AS dropped
    WHERE dropped.attrelid = c.oid
      AND dropped.attnum > 0
      AND dropped.attisdropped
  ) AS dropped_column_count,
  COALESCE(pg_catalog.to_jsonb(c.reloptions), '[]'::pg_catalog.jsonb)
    AS table_options,
  (
    SELECT am.amname
    FROM pg_catalog.pg_am AS am
    WHERE am.oid = c.relam
  ) AS table_access_method,
  (
    SELECT pg_catalog.count(*)::integer
    FROM pg_catalog.pg_rewrite AS r
    WHERE r.ev_class = c.oid
  ) AS rule_count,
  (
    SELECT pg_catalog.count(*)::integer
    FROM pg_catalog.pg_inherits AS i
    WHERE i.inhrelid = c.oid
  ) AS parent_count,
  (
    SELECT pg_catalog.count(*)::integer
    FROM pg_catalog.pg_inherits AS i
    WHERE i.inhparent = c.oid
  ) AS child_count,
  (
    SELECT pg_catalog.count(*)::integer
    FROM pg_catalog.pg_policy AS p
    WHERE p.polrelid = c.oid
  ) AS policy_count,
  pg_catalog.pg_get_userbyid(c.relowner) AS table_owner,
  pg_catalog.obj_description(c.oid, 'pg_class') AS table_comment,
  c.relrowsecurity AS row_security,
  c.relforcerowsecurity AS force_row_security,
  COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'position', a.attnum,
      'name', a.attname,
      'dataType', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'notNull', a.attnotnull,
      'defaultExpression', pg_catalog.pg_get_expr(d.adbin, d.adrelid, false),
      'identity', a.attidentity,
      'generated', a.attgenerated,
      'hasColumnAcl', a.attacl IS NOT NULL,
      'columnAcl', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantee', CASE acl.grantee
            WHEN 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(acl.grantee)
          END,
          'grantor', pg_catalog.pg_get_userbyid(acl.grantor),
          'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        ) ORDER BY
          CASE acl.grantee WHEN 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
          acl.privilege_type)
        FROM pg_catalog.aclexplode(a.attacl) AS acl
      ), '[]'::pg_catalog.jsonb),
      'collation', CASE a.attcollation
        WHEN 0 THEN NULL
        ELSE pg_catalog.jsonb_build_object(
          'schema', cn.nspname,
          'name', coll.collname
        )
      END,
      'isLocal', a.attislocal,
      'inheritanceCount', a.attinhcount,
      'hasMissing', a.atthasmissing
    ) ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_type AS ty ON ty.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_collation AS coll ON coll.oid = a.attcollation
    LEFT JOIN pg_catalog.pg_namespace AS cn ON cn.oid = coll.collnamespace
    LEFT JOIN pg_catalog.pg_attrdef AS d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = c.oid
      AND a.attnum > 0
      AND NOT a.attisdropped
  ), '[]'::pg_catalog.jsonb) AS columns,
  COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', con.conname,
      'type', con.contype,
      'validated', con.convalidated,
      'deferrable', con.condeferrable,
      'deferred', con.condeferred,
      'noInherit', con.connoinherit,
      'isLocal', con.conislocal,
      'inheritanceCount', con.coninhcount,
      'parentConstraintOid', con.conparentid::text,
      'columns', COALESCE((
        SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.ordinality)
        FROM pg_catalog.unnest(con.conkey) WITH ORDINALITY
          AS k(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS a
          ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      ), '[]'::pg_catalog.jsonb),
      'definition', pg_catalog.pg_get_constraintdef(con.oid, false)
    ) ORDER BY con.conname)
    FROM pg_catalog.pg_constraint AS con
    WHERE con.conrelid = c.oid
  ), '[]'::pg_catalog.jsonb) AS constraints,
  COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', ic.relname,
      'accessMethod', am.amname,
      'unique', i.indisunique,
      'primary', i.indisprimary,
      'exclusion', i.indisexclusion,
      'immediate', i.indimmediate,
      'clustered', i.indisclustered,
      'valid', i.indisvalid,
      'ready', i.indisready,
      'live', i.indislive,
      'replicaIdentity', i.indisreplident,
      'keyColumns', COALESCE((
        SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.ordinality)
        FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY
          AS k(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS a
          ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE k.ordinality <= i.indnkeyatts
      ), '[]'::pg_catalog.jsonb),
      'includedColumns', COALESCE((
        SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.ordinality)
        FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY
          AS k(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS a
          ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE k.ordinality > i.indnkeyatts
      ), '[]'::pg_catalog.jsonb),
      'predicate', pg_catalog.pg_get_expr(i.indpred, i.indrelid, false),
      'expressions', pg_catalog.pg_get_expr(i.indexprs, i.indrelid, false),
      'definition', pg_catalog.pg_get_indexdef(i.indexrelid, 0, false)
    ) ORDER BY ic.relname)
    FROM pg_catalog.pg_index AS i
    JOIN pg_catalog.pg_class AS ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_am AS am ON am.oid = ic.relam
    WHERE i.indrelid = c.oid
  ), '[]'::pg_catalog.jsonb) AS indexes,
  COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'grantee', CASE acl.grantee
        WHEN 0 THEN 'PUBLIC'
        ELSE pg_catalog.pg_get_userbyid(acl.grantee)
      END,
      'grantor', pg_catalog.pg_get_userbyid(acl.grantor),
      'privilege', acl.privilege_type,
      'grantable', acl.is_grantable
    ) ORDER BY
      CASE acl.grantee WHEN 0 THEN 'PUBLIC'
        ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
      acl.privilege_type)
    FROM pg_catalog.aclexplode(
      COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
    ) AS acl
  ), '[]'::pg_catalog.jsonb) AS table_acl,
  COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', t.tgname,
      'enabled', t.tgenabled,
      'type', t.tgtype,
      'internal', t.tgisinternal,
      'argumentCount', t.tgnargs,
      'affectedColumns', COALESCE((
        SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.ordinality)
        FROM pg_catalog.unnest(t.tgattr::smallint[]) WITH ORDINALITY
          AS k(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS a
          ON a.attrelid = c.oid AND a.attnum = k.attnum
      ), '[]'::pg_catalog.jsonb),
      'whenExpression', pg_catalog.pg_get_expr(t.tgqual, c.oid, false),
      'parentTriggerOid', t.tgparentid::text,
      'constraintOid', t.tgconstraint::text,
      'constraintRelationOid', t.tgconstrrelid::text,
      'constraintIndexOid', t.tgconstrindid::text,
      'deferrable', t.tgdeferrable,
      'initiallyDeferred', t.tginitdeferred,
      'oldTransitionTable', t.tgoldtable,
      'newTransitionTable', t.tgnewtable,
      'triggerComment', pg_catalog.obj_description(t.trigger_oid, 'pg_trigger'),
      'functionSchema', t.function_schema,
      'functionName', t.proname,
      'functionOwner', pg_catalog.pg_get_userbyid(t.proowner),
      'functionLanguage', t.function_language,
      'functionSecurityDefiner', t.prosecdef,
      'functionLeakproof', t.proleakproof,
      'functionStrict', t.proisstrict,
      'functionReturnsSet', t.proretset,
      'functionKind', t.prokind,
      'functionVolatility', t.provolatile,
      'functionParallel', t.proparallel,
      'functionArgumentCount', t.pronargs,
      'functionResult', t.function_result,
      'functionSource', pg_catalog.btrim(
        pg_catalog.replace(t.prosrc, E'\\r\\n', E'\\n'),
        E' \\t\\r\\n'
      ),
      'functionConfig', COALESCE(pg_catalog.to_jsonb(t.proconfig), '[]'::pg_catalog.jsonb),
      'functionComment', pg_catalog.obj_description(t.function_oid, 'pg_proc'),
      'functionAcl', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantee', CASE acl.grantee
            WHEN 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(acl.grantee)
          END,
          'grantor', pg_catalog.pg_get_userbyid(acl.grantor),
          'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        ) ORDER BY
          CASE acl.grantee WHEN 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
          acl.privilege_type)
        FROM pg_catalog.pg_proc AS fp
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(fp.proacl, pg_catalog.acldefault('f', fp.proowner))
        ) AS acl
        WHERE fp.oid = t.function_oid
      ), '[]'::pg_catalog.jsonb)
    ) ORDER BY t.tgname)
    FROM guard_trigger AS t
  ), '[]'::pg_catalog.jsonb) AS triggers
FROM target_table AS c
`;
const DESTROY_ADVISORY_UNLOCK_SQL = `
SELECT pg_catalog.pg_advisory_unlock(
  pg_catalog.hashtextextended($1::text, 0)
) AS unlocked
`;
const DESTROY_REGISTRY_SELECT_SQL = `
SELECT
  stable_identity,
  resource_generation::text AS resource_generation,
  ownership_marker,
  target_database_name,
  target_role_name,
  provision_external_epoch::text AS provision_external_epoch,
  provision_external_marker,
  provision_external_operation_hash,
  cleanup_external_epoch::text AS cleanup_external_epoch,
  cleanup_external_marker,
  cleanup_external_operation_hash,
  lifecycle_status,
  database_deleted,
  role_deleted
FROM ${TENANT_LIFECYCLE_REGISTRY_TABLE}
WHERE stable_identity = $1
  AND resource_generation = $2::bigint
FOR UPDATE
`;
const DESTROY_REGISTRY_INSERT_SQL = `
INSERT INTO ${TENANT_LIFECYCLE_REGISTRY_TABLE} (
  stable_identity,
  resource_generation,
  ownership_marker,
  target_database_name,
  target_role_name,
  provision_external_epoch,
  provision_external_marker,
  provision_external_operation_hash,
  cleanup_external_epoch,
  cleanup_external_marker,
  cleanup_external_operation_hash,
  lifecycle_status,
  database_deleted,
  role_deleted
) VALUES (
  $1, $2::bigint, $3, $4, $5, $6::bigint, $7, $8,
  $9::bigint, $10, $11, 'destroying', false, false
)
RETURNING stable_identity
`;
const DESTROY_REGISTRY_UPDATE_SQL = `
UPDATE ${TENANT_LIFECYCLE_REGISTRY_TABLE}
SET database_deleted = $12::boolean,
    role_deleted = $13::boolean,
    lifecycle_status = $14,
    updated_at = pg_catalog.clock_timestamp()
WHERE stable_identity = $1
  AND resource_generation = $2::bigint
  AND ownership_marker = $3
  AND target_database_name = $4
  AND target_role_name = $5
  AND provision_external_epoch = $6::bigint
  AND provision_external_marker = $7
  AND provision_external_operation_hash = $8
  AND cleanup_external_epoch = $9::bigint
  AND cleanup_external_marker = $10
  AND cleanup_external_operation_hash = $11
RETURNING stable_identity
`;

function fail(code, message, retryable = false) {
  throw new TenantLifecycleContractError(code, message, retryable);
}

function exactKeys(value, expected) {
  return Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) ===
      canonicalJson([...expected].sort());
}

function productionRuntimeModeForOperation(operation) {
  return typeof operation === 'string' &&
    Object.hasOwn(PRODUCTION_RUNTIME_MODE_BY_OPERATION, operation)
    ? PRODUCTION_RUNTIME_MODE_BY_OPERATION[operation]
    : null;
}

function quoteTenantIdentifier(value, kind) {
  const pattern = kind === 'database'
    ? /^tenant_[a-z0-9]{1,16}_db$/
    : kind === 'role'
      ? /^tenant_[a-z0-9]{1,16}_role$/
      : null;
  if (!pattern || !pattern.test(String(value || ''))) {
    fail(
      'TENANT_DATABASE_IDENTIFIER_INVALID',
      'A lifecycle SQL identifier is outside the reviewed tenant namespace.',
    );
  }
  return `"${value}"`;
}

function destroyRegistryValues(input) {
  const predecessor = input.provisionPredecessor;
  return [
    input.stableIdentity,
    input.resourceGeneration,
    input.ownershipMarker,
    input.managementTarget.targetDatabaseName,
    input.managementTarget.targetRoleName,
    predecessor.epoch,
    predecessor.marker,
    predecessor.operationHash,
    input.externalOperationEpoch,
    input.externalOperationMarker,
    input.externalOperationHash,
  ];
}

function assertDestroyRegistryRow(row, input) {
  const expectedKeys = [
    'stable_identity',
    'resource_generation',
    'ownership_marker',
    'target_database_name',
    'target_role_name',
    'provision_external_epoch',
    'provision_external_marker',
    'provision_external_operation_hash',
    'cleanup_external_epoch',
    'cleanup_external_marker',
    'cleanup_external_operation_hash',
    'lifecycle_status',
    'database_deleted',
    'role_deleted',
  ];
  const predecessor = input.provisionPredecessor;
  if (
    !exactKeys(row, expectedKeys) ||
    row.stable_identity !== input.stableIdentity ||
    row.resource_generation !== String(input.resourceGeneration) ||
    row.ownership_marker !== input.ownershipMarker ||
    row.target_database_name !== input.managementTarget.targetDatabaseName ||
    row.target_role_name !== input.managementTarget.targetRoleName ||
    row.provision_external_epoch !== String(predecessor.epoch) ||
    row.provision_external_marker !== predecessor.marker ||
    row.provision_external_operation_hash !== predecessor.operationHash ||
    row.cleanup_external_epoch !== String(input.externalOperationEpoch) ||
    row.cleanup_external_marker !== input.externalOperationMarker ||
    row.cleanup_external_operation_hash !== input.externalOperationHash ||
    !['destroying', 'destroyed'].includes(row.lifecycle_status) ||
    typeof row.database_deleted !== 'boolean' ||
    typeof row.role_deleted !== 'boolean' ||
    (row.lifecycle_status === 'destroyed' &&
      (!row.database_deleted || !row.role_deleted))
  ) {
    fail(
      'TENANT_DATABASE_CLEANUP_PREDECESSOR_MISMATCH',
      'The cleanup registry does not match the exact resource, provision predecessor, and cleanup fence.',
    );
  }
  return Object.freeze({
    lifecycleStatus: row.lifecycle_status,
    databaseDeleted: row.database_deleted,
    roleDeleted: row.role_deleted,
  });
}

async function withPostgresTransaction(client, signal, action) {
  signal.throwIfAborted();
  await client.query({ text: 'BEGIN', values: [] });
  try {
    const output = await action();
    signal.throwIfAborted();
    await client.query({ text: 'COMMIT', values: [] });
    return output;
  } catch (error) {
    try {
      await client.query({ text: 'ROLLBACK', values: [] });
    } catch {
      destroyClientStream(client);
    }
    throw error;
  }
}

function environmentText(environment, name) {
  const value = environment?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function assertProductionRuntimeEnvironment({ environment, input }) {
  const expectedRuntimeMode =
    productionRuntimeModeForOperation(input?.operation);
  if (
    !expectedRuntimeMode ||
    environmentText(environment, 'APP_RUNTIME_MODE') !== expectedRuntimeMode ||
    environmentText(environment, 'NODE_ENV') !== 'production'
  ) {
    fail(
      'TENANT_LIFECYCLE_RUNTIME_MODE_INVALID',
      'The production lifecycle CLI requires its exact one-shot runtime mode.',
    );
  }
  for (const name of FORBIDDEN_AWS_ENVIRONMENT) {
    if (environmentText(environment, name)) {
      fail(
        'TENANT_LIFECYCLE_AWS_OVERRIDE_FORBIDDEN',
        'AWS credential-source, endpoint, and profile overrides are forbidden for lifecycle tasks.',
      );
    }
  }
  for (const [name, value] of Object.entries(environment || {})) {
    if (
      name.startsWith('PG') &&
      environmentText(environment, name) &&
      ALLOWED_PG_ENVIRONMENT[name] !== value
    ) {
      fail(
        'TENANT_LIFECYCLE_POSTGRES_OVERRIDE_FORBIDDEN',
        'PostgreSQL environment overrides are forbidden for lifecycle tasks.',
      );
    }
  }
  for (const [name, expected] of Object.entries(ALLOWED_PG_ENVIRONMENT)) {
    if (environment?.[name] !== expected) {
      fail(
        'TENANT_LIFECYCLE_POSTGRES_TLS_INVALID',
        'The production lifecycle CLI requires the image-bundled RDS TLS settings.',
      );
    }
  }
  for (const name of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
    const value = environmentText(environment, name);
    if (value !== null && value !== input.aws.region) {
      fail(
        'TENANT_LIFECYCLE_AWS_REGION_MISMATCH',
        'The AWS SDK region must match the lifecycle Secret ARN.',
      );
    }
  }
}

function validateProductionInvocation(argv, environment) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const command = args.length === 1 ? args[0] : null;
  const expectedRuntimeMode = productionRuntimeModeForOperation(command);
  if (!expectedRuntimeMode) {
    fail(
      'TENANT_LIFECYCLE_COMMAND_DISABLED',
      'Only the fixed inspect and cleanup-only destroy lifecycle commands are enabled.',
    );
  }
  if (
    environmentText(environment, 'APP_RUNTIME_MODE') !==
    expectedRuntimeMode
  ) {
    fail(
      'TENANT_LIFECYCLE_RUNTIME_MODE_INVALID',
      'The production lifecycle CLI requires its exact one-shot runtime mode.',
    );
  }
  return command;
}

function secretReadError(error, signal, label) {
  signal.throwIfAborted();
  if (error instanceof TenantLifecycleContractError) return error;
  const status = Number(error?.$metadata?.httpStatusCode || 0);
  const name = String(error?.name || error?.code || '');
  return new TenantLifecycleContractError(
    'TENANT_LIFECYCLE_SECRET_READ_FAILED',
    `${label} could not be read safely.`,
    Boolean(error?.$retryable) ||
      status === 408 ||
      status === 429 ||
      status >= 500 ||
      /Throttl|Timeout|Unavailable|Internal/i.test(name),
  );
}

function parseSecretResponse({ response, secretArn, expectedKeys, label }) {
  if (
    !response ||
    typeof response !== 'object' ||
    response.ARN !== secretArn ||
    typeof response.SecretString !== 'string' ||
    Buffer.byteLength(response.SecretString, 'utf8') < 2 ||
    Buffer.byteLength(response.SecretString, 'utf8') > MAX_SECRET_BYTES ||
    response.SecretBinary !== undefined ||
    !Array.isArray(response.VersionStages) ||
    !response.VersionStages.includes('AWSCURRENT')
  ) {
    fail(
      'TENANT_LIFECYCLE_SECRET_INVALID',
      `${label} response does not match the exact AWSCURRENT Secret contract.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.SecretString);
  } catch {
    parsed = null;
  }
  if (!exactKeys(parsed, expectedKeys)) {
    fail(
      'TENANT_LIFECYCLE_SECRET_INVALID',
      `${label} does not contain the exact reviewed JSON keys.`,
    );
  }
  return parsed;
}

function assertSecretText(value, label) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 8192 ||
    /[\r\n\0]/.test(value)
  ) {
    fail(
      'TENANT_LIFECYCLE_SECRET_INVALID',
      `${label} contains an invalid bounded value.`,
    );
  }
}

class AwsSdkTenantRuntimeSecretProvider {
  constructor({ client, GetSecretValueCommand }) {
    if (!client || typeof client.send !== 'function' ||
        typeof GetSecretValueCommand !== 'function') {
      fail(
        'TENANT_LIFECYCLE_SECRET_PROVIDER_INVALID',
        'The runtime Secret provider requires injected AWS SDK v3 dependencies.',
      );
    }
    this.client = client;
    this.GetSecretValueCommand = GetSecretValueCommand;
  }

  async useRuntimeSecret({ input, secretArn, signal, use }) {
    signal.throwIfAborted();
    if (
      input?.runtimeSecretArn !== secretArn ||
      !productionRuntimeModeForOperation(input?.operation) ||
      typeof use !== 'function'
    ) {
      fail(
        'TENANT_LIFECYCLE_SECRET_PROVIDER_INVALID',
        'The runtime Secret callback is not bound to the parsed task input.',
      );
    }
    let response;
    try {
      response = await this.client.send(
        new this.GetSecretValueCommand({
          SecretId: secretArn,
          VersionStage: 'AWSCURRENT',
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      throw secretReadError(error, signal, 'The tenant runtime Secret');
    }
    let secret = parseSecretResponse({
      response,
      secretArn,
      expectedKeys: SECRET_KEYS,
      label: 'The tenant runtime Secret',
    });
    try {
      for (const key of SECRET_KEYS) assertSecretText(secret[key], key);
      assertRuntimeSecret(secret, input);
      signal.throwIfAborted();
      return await use(secret);
    } finally {
      secret = null;
      response = null;
    }
  }
}

class AwsSdkTenantManagementSecretProvider {
  constructor({ client, GetSecretValueCommand }) {
    if (!client || typeof client.send !== 'function' ||
        typeof GetSecretValueCommand !== 'function') {
      fail(
        'TENANT_LIFECYCLE_SECRET_PROVIDER_INVALID',
        'The management Secret provider requires injected AWS SDK v3 dependencies.',
      );
    }
    this.client = client;
    this.GetSecretValueCommand = GetSecretValueCommand;
  }

  async useManagementSecret({ input, signal, use }) {
    signal.throwIfAborted();
    const target = input?.managementTarget;
    if (
      !target ||
      !productionRuntimeModeForOperation(input?.operation) ||
      typeof use !== 'function'
    ) {
      fail(
        'TENANT_LIFECYCLE_SECRET_PROVIDER_INVALID',
        'The management Secret callback is not bound to the parsed task input.',
      );
    }
    let response;
    try {
      response = await this.client.send(
        new this.GetSecretValueCommand({
          SecretId: target.managementSecretArn,
          VersionStage: 'AWSCURRENT',
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      throw secretReadError(error, signal, 'The Shared Cell management Secret');
    }
    let secret = parseSecretResponse({
      response,
      secretArn: target.managementSecretArn,
      expectedKeys: MANAGEMENT_SECRET_KEYS,
      label: 'The Shared Cell management Secret',
    });
    try {
      assertSecretText(secret.username, 'management username');
      assertSecretText(secret.password, 'management password');
      if (
        secret.username !== target.managementUsername ||
        target.managementEndpoint.length > 253 ||
        target.managementPort !== 5432 ||
        target.managementDatabase !== 'cell_admin'
      ) {
        fail(
          'TENANT_DATABASE_MANAGEMENT_SECRET_MISMATCH',
          'The management Secret does not match the exact Shared Cell target.',
        );
      }
      const connection = Object.freeze({
        host: target.managementEndpoint,
        port: target.managementPort,
        database: target.managementDatabase,
        user: target.managementUsername,
        password: secret.password,
      });
      signal.throwIfAborted();
      return await use(connection);
    } finally {
      secret = null;
      response = null;
    }
  }
}

function parseMetadataComment(value, expectedKind) {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') < 2 ||
    Buffer.byteLength(value, 'utf8') > 8192 ||
    /[\r\n\0]/.test(value)
  ) {
    fail(
      'TENANT_DATABASE_METADATA_INVALID',
      'Tenant database ownership metadata is not bounded canonical JSON.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  if (
    !exactKeys(parsed, DATABASE_METADATA_KEYS) ||
    parsed.schemaVersion !== 1 ||
    parsed.kind !== expectedKind ||
    typeof parsed.ownershipMarker !== 'string' ||
    !parsed.marker ||
    typeof parsed.marker !== 'object' ||
    Array.isArray(parsed.marker) ||
    canonicalJson(parsed) !== value
  ) {
    fail(
      'TENANT_DATABASE_METADATA_INVALID',
      'Tenant database ownership metadata is not the exact reviewed envelope.',
    );
  }
  return parsed;
}

function postgresError(error, signal, operation = 'inspect') {
  signal.throwIfAborted();
  if (error instanceof TenantLifecycleContractError) return error;
  const code = String(error?.code || '');
  return new TenantLifecycleContractError(
    operation === 'destroy'
      ? 'TENANT_DATABASE_DESTROY_FAILED'
      : 'TENANT_DATABASE_INSPECT_FAILED',
    operation === 'destroy'
      ? 'The fenced PostgreSQL lifecycle destroy failed safely.'
      : 'The read-only PostgreSQL lifecycle inspection failed safely.',
    code.startsWith('08') ||
      ['53300', '57P01', '57P02', '57P03'].includes(code) ||
      /ECONNRESET|ETIMEDOUT|EPIPE/.test(code),
  );
}

function destroyClientStream(client) {
  const stream = client?.connection?.stream;
  if (stream && typeof stream.destroy === 'function') {
    try {
      stream.destroy();
    } catch {
      // Cleanup must never replace the original, sanitized operation error.
    }
  }
}

async function boundedEndClient(
  client,
  {
    timeoutMs = POSTGRES_CLEANUP_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  let timer;
  const endPromise = Promise.resolve().then(() => client.end());
  // Own a possible rejection even after the timeout wins the race. Otherwise
  // a late pg cleanup failure could become an unhandled rejection.
  endPromise.catch(() => {});
  const settledEnd = endPromise.then(
    () => 'ended',
    () => 'failed',
  );
  const timeout = new Promise((resolve) => {
    timer = setTimer(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const disposition = await Promise.race([settledEnd, timeout]);
    if (disposition !== 'ended') destroyClientStream(client);
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}

function validateMetadataEvidence(row, prefix, resourceExists) {
  const comment = row[`${prefix}_comment`];
  const bytes = row[`${prefix}_comment_bytes`];
  const tooLarge = row[`${prefix}_comment_too_large`];
  const commentTypeValid = comment === null || typeof comment === 'string';
  const bytesValid = Number.isSafeInteger(bytes) && bytes >= 0;
  const tooLargeValid = typeof tooLarge === 'boolean';
  const returnedBytes = typeof comment === 'string'
    ? Buffer.byteLength(comment, 'utf8')
    : null;
  if (
    !commentTypeValid ||
    !bytesValid ||
    !tooLargeValid ||
    tooLarge !== (bytes > MAX_DATABASE_METADATA_BYTES) ||
    (typeof comment === 'string' &&
      (tooLarge ||
        returnedBytes !== bytes ||
        bytes > MAX_DATABASE_METADATA_BYTES)) ||
    (comment === null && bytes > 0 && !tooLarge) ||
    (!resourceExists && (comment !== null || bytes !== 0 || tooLarge))
  ) {
    fail(
      'TENANT_DATABASE_OBSERVATION_INVALID',
      'PostgreSQL returned an invalid bounded lifecycle observation.',
    );
  }
  if (tooLarge) {
    fail(
      'TENANT_DATABASE_METADATA_TOO_LARGE',
      'Tenant database ownership metadata exceeds the reviewed byte limit.',
    );
  }
}

function assertDestroyOwnershipMetadata(metadata, input) {
  const marker = metadata?.marker;
  if (!metadata || metadata.ownershipMarker !== input.ownershipMarker || !marker) {
    fail(
      'TENANT_DATABASE_OWNERSHIP_UNPROVEN',
      'Destroy requires the exact canonical ownership metadata on every remaining resource.',
    );
  }
  assertMarkerShape(marker);
  const predecessor = input.provisionPredecessor;
  if (
    marker.stableIdentity !== input.stableIdentity ||
    marker.stableIdentityHashPrefix !== input.stableIdentityHashPrefix ||
    marker.resourceGeneration !== input.resourceGeneration ||
    marker.ownershipMarker !== input.ownershipMarker ||
    marker.provisionExternalEpoch !== predecessor.epoch ||
    marker.provisionExternalMarker !== predecessor.marker ||
    marker.provisionExternalOperationHash !== predecessor.operationHash
  ) {
    fail(
      'TENANT_DATABASE_CLEANUP_PREDECESSOR_MISMATCH',
      'Destroy ownership metadata does not match the exact provision predecessor.',
    );
  }
  return marker;
}

async function readDestroyResourceEvidence(client, input, signal) {
  const result = await client.query({
    text: INSPECT_RESOURCES_SQL,
    values: [
      input.managementTarget.targetDatabaseName,
      input.managementTarget.targetRoleName,
    ],
  });
  signal.throwIfAborted();
  const row = result?.rows?.[0];
  if (
    result?.rowCount !== 1 ||
    !exactKeys(row, [
      'database_exists',
      'database_comment',
      'database_comment_bytes',
      'database_comment_too_large',
      'role_exists',
      'role_comment',
      'role_comment_bytes',
      'role_comment_too_large',
    ]) ||
    typeof row.database_exists !== 'boolean' ||
    typeof row.role_exists !== 'boolean'
  ) {
    fail(
      'TENANT_DATABASE_OBSERVATION_INVALID',
      'PostgreSQL returned an invalid bounded lifecycle observation.',
    );
  }
  validateMetadataEvidence(row, 'database', row.database_exists);
  validateMetadataEvidence(row, 'role', row.role_exists);
  const databaseMetadata = parseMetadataComment(
    row.database_comment,
    DATABASE_METADATA_KINDS.database,
  );
  const roleMetadata = parseMetadataComment(
    row.role_comment,
    DATABASE_METADATA_KINDS.role,
  );
  const databaseMarker = row.database_exists
    ? assertDestroyOwnershipMetadata(databaseMetadata, input)
    : null;
  const roleMarker = row.role_exists
    ? assertDestroyOwnershipMetadata(roleMetadata, input)
    : null;
  if (
    databaseMarker &&
    roleMarker &&
    canonicalJson(databaseMarker) !== canonicalJson(roleMarker)
  ) {
    fail(
      'TENANT_DATABASE_METADATA_INVALID',
      'Tenant database and role lifecycle markers disagree.',
    );
  }
  return Object.freeze({
    databaseExists: row.database_exists,
    roleExists: row.role_exists,
  });
}

async function readDestroyRegistry(client, input, signal) {
  const result = await client.query({
    text: DESTROY_REGISTRY_SELECT_SQL,
    values: [input.stableIdentity, input.resourceGeneration],
  });
  signal.throwIfAborted();
  if (!result || ![0, 1].includes(result.rowCount) || !Array.isArray(result.rows)) {
    fail(
      'TENANT_DATABASE_CLEANUP_REGISTRY_INVALID',
      'The lifecycle cleanup registry returned an invalid result.',
    );
  }
  if (result.rowCount === 0) return null;
  return assertDestroyRegistryRow(result.rows[0], input);
}

function registryOwnerAcl(owner, privileges) {
  return privileges.map((privilege) => Object.freeze({
    grantee: owner,
    grantor: owner,
    privilege,
    grantable: false,
  }));
}

function registryGuardTriggerIdentity(owner, name, type) {
  return Object.freeze({
    name,
    enabled: 'O',
    type,
    internal: false,
    argumentCount: 0,
    affectedColumns: Object.freeze([]),
    whenExpression: null,
    parentTriggerOid: '0',
    constraintOid: '0',
    constraintRelationOid: '0',
    constraintIndexOid: '0',
    deferrable: false,
    initiallyDeferred: false,
    oldTransitionTable: null,
    newTransitionTable: null,
    triggerComment: TENANT_LIFECYCLE_REGISTRY_TRIGGER_COMMENT,
    functionSchema: 'public',
    functionName: 'techlong_tenant_lifecycle_registry_guard',
    functionOwner: owner,
    functionLanguage: 'plpgsql',
    functionSecurityDefiner: false,
    functionLeakproof: false,
    functionStrict: false,
    functionReturnsSet: false,
    functionKind: 'f',
    functionVolatility: 'v',
    functionParallel: 'u',
    functionArgumentCount: 0,
    functionResult: 'trigger',
    functionSource: TENANT_LIFECYCLE_REGISTRY_GUARD_SOURCE,
    functionConfig: Object.freeze(['search_path=pg_catalog']),
    functionComment: TENANT_LIFECYCLE_REGISTRY_GUARD_COMMENT,
    functionAcl: Object.freeze(registryOwnerAcl(owner, ['EXECUTE'])),
  });
}

async function assertDestroyRegistryIdentity(client, connection, signal) {
  const result = await client.query({
    text: DESTROY_REGISTRY_IDENTITY_SQL,
    values: [],
  });
  signal.throwIfAborted();
  const row = result?.rows?.[0];
  if (
    result?.rowCount !== 1 ||
    !exactKeys(row, [
      'relkind',
      'persistence',
      'replica_identity',
      'is_partition',
      'has_no_typed_table',
      'has_rules',
      'has_subclass',
      'attribute_count',
      'dropped_column_count',
      'table_options',
      'table_access_method',
      'rule_count',
      'parent_count',
      'child_count',
      'policy_count',
      'table_owner',
      'table_comment',
      'row_security',
      'force_row_security',
      'columns',
      'constraints',
      'indexes',
      'table_acl',
      'triggers',
    ]) ||
    row.relkind !== 'r' ||
    row.persistence !== 'p' ||
    row.replica_identity !== 'd' ||
    row.is_partition !== false ||
    row.has_no_typed_table !== true ||
    row.has_rules !== false ||
    row.has_subclass !== false ||
    row.attribute_count !== TENANT_LIFECYCLE_REGISTRY_COLUMNS.length ||
    row.dropped_column_count !== 0 ||
    canonicalJson(row.table_options) !== canonicalJson([]) ||
    row.table_access_method !== 'heap' ||
    row.rule_count !== 0 ||
    row.parent_count !== 0 ||
    row.child_count !== 0 ||
    row.policy_count !== 0 ||
    row.table_owner !== connection.user ||
    row.table_comment !== TENANT_LIFECYCLE_REGISTRY_COMMENT ||
    row.row_security !== false ||
    row.force_row_security !== false ||
    canonicalJson(row.columns) !==
      canonicalJson(TENANT_LIFECYCLE_REGISTRY_COLUMN_IDENTITIES) ||
    canonicalJson(row.constraints) !==
      canonicalJson(TENANT_LIFECYCLE_REGISTRY_CONSTRAINT_IDENTITIES) ||
    canonicalJson(row.indexes) !==
      canonicalJson(TENANT_LIFECYCLE_REGISTRY_INDEX_IDENTITIES) ||
    canonicalJson(row.table_acl) !== canonicalJson(registryOwnerAcl(
      connection.user,
      [
        'INSERT',
        'SELECT',
        'UPDATE',
      ],
    )) ||
    canonicalJson(row.triggers) !== canonicalJson([
      registryGuardTriggerIdentity(
        connection.user,
        'techlong_tenant_lifecycle_registry_guard_trg',
        27,
      ),
      registryGuardTriggerIdentity(
        connection.user,
        'techlong_tenant_lifecycle_registry_truncate_guard_trg',
        34,
      ),
    ])
  ) {
    fail(
      'TENANT_DATABASE_CLEANUP_REGISTRY_INVALID',
      'The cell_admin lifecycle registry is missing or does not match the exact non-secret schema identity.',
    );
  }
}

async function insertDestroyRegistry(client, input, signal) {
  const result = await client.query({
    text: DESTROY_REGISTRY_INSERT_SQL,
    values: destroyRegistryValues(input),
  });
  signal.throwIfAborted();
  if (
    result?.rowCount !== 1 ||
    !exactKeys(result.rows?.[0], ['stable_identity']) ||
    result.rows[0].stable_identity !== input.stableIdentity
  ) {
    fail(
      'TENANT_DATABASE_CLEANUP_REGISTRY_INVALID',
      'The exact lifecycle cleanup intent was not persisted.',
      true,
    );
  }
  return Object.freeze({
    lifecycleStatus: 'destroying',
    databaseDeleted: false,
    roleDeleted: false,
  });
}

async function updateDestroyRegistry(
  client,
  input,
  { databaseDeleted, roleDeleted },
  signal,
) {
  const lifecycleStatus =
    databaseDeleted && roleDeleted ? 'destroyed' : 'destroying';
  const result = await client.query({
    text: DESTROY_REGISTRY_UPDATE_SQL,
    values: [
      ...destroyRegistryValues(input),
      databaseDeleted,
      roleDeleted,
      lifecycleStatus,
    ],
  });
  signal.throwIfAborted();
  if (
    result?.rowCount !== 1 ||
    !exactKeys(result.rows?.[0], ['stable_identity']) ||
    result.rows[0].stable_identity !== input.stableIdentity
  ) {
    fail(
      'TENANT_DATABASE_CLEANUP_REGISTRY_INVALID',
      'The lifecycle cleanup tombstone could not be advanced exactly.',
      true,
    );
  }
  return Object.freeze({
    lifecycleStatus,
    databaseDeleted,
    roleDeleted,
  });
}

class PostgresTenantLifecycleInspectPort {
  constructor({ managementSecretProvider, Client, ca }) {
    if (
      !managementSecretProvider ||
      typeof managementSecretProvider.useManagementSecret !== 'function' ||
      typeof Client !== 'function' ||
      typeof ca !== 'string' ||
      ca.length < 100 ||
      ca.length > 1_000_000 ||
      !ca.includes('-----BEGIN CERTIFICATE-----')
    ) {
      fail(
        'TENANT_DATABASE_PROVIDER_INVALID',
        'The PostgreSQL inspect provider requires a management Secret provider and the RDS CA bundle.',
      );
    }
    this.managementSecretProvider = managementSecretProvider;
    this.Client = Client;
    this.ca = ca;
  }

  async inspect({ input, runtimeSecret, signal }) {
    signal.throwIfAborted();
    if (input?.operation !== 'inspect') {
      fail(
        'TENANT_LIFECYCLE_COMMAND_DISABLED',
        'The production PostgreSQL provider accepts only read-only inspect.',
      );
    }
    if (!exactKeys(runtimeSecret, ['database_url'])) {
      fail(
        'TENANT_RUNTIME_SECRET_INVALID',
        'The PostgreSQL provider accepts only the validated tenant database reference.',
      );
    }
    return this.managementSecretProvider.useManagementSecret({
      input,
      signal,
      use: async (connection) => {
        const client = new this.Client({
          host: connection.host,
          port: connection.port,
          database: connection.database,
          user: connection.user,
          password: connection.password,
          ssl: Object.freeze({ ca: this.ca, rejectUnauthorized: true }),
          application_name: 'techlong-tenant-lifecycle-inspect',
          options: PG_STARTUP_OPTIONS,
          connectionTimeoutMillis: 10_000,
          query_timeout: 5_000,
          statement_timeout: 5_000,
          lock_timeout: 1_000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 1_000,
        });
        const abort = () => {
          destroyClientStream(client);
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          await client.connect();
          signal.throwIfAborted();
          const identityResult = await client.query({
            text: INSPECT_IDENTITY_SQL,
            values: [],
          });
          signal.throwIfAborted();
          const identity = identityResult?.rows?.[0];
          if (
            identityResult?.rowCount !== 1 ||
            !exactKeys(identity, [
              'management_database',
              'management_username',
              'management_port',
              'read_only',
              'tls_active',
            ]) ||
            identity.management_database !== connection.database ||
            identity.management_username !== connection.user ||
            Number(identity.management_port) !== connection.port ||
            identity.read_only !== 'on' ||
            identity.tls_active !== true
          ) {
            fail(
              'TENANT_DATABASE_CONNECTION_IDENTITY_MISMATCH',
              'PostgreSQL did not prove the exact TLS read-only management connection.',
            );
          }
          const resourceResult = await client.query({
            text: INSPECT_RESOURCES_SQL,
            values: [
              input.managementTarget.targetDatabaseName,
              input.managementTarget.targetRoleName,
            ],
          });
          signal.throwIfAborted();
          const row = resourceResult?.rows?.[0];
          if (
            resourceResult?.rowCount !== 1 ||
            !exactKeys(row, [
              'database_exists',
              'database_comment',
              'database_comment_bytes',
              'database_comment_too_large',
              'role_exists',
              'role_comment',
              'role_comment_bytes',
              'role_comment_too_large',
            ]) ||
            typeof row.database_exists !== 'boolean' ||
            typeof row.role_exists !== 'boolean'
          ) {
            fail(
              'TENANT_DATABASE_OBSERVATION_INVALID',
              'PostgreSQL returned an invalid bounded lifecycle observation.',
            );
          }
          validateMetadataEvidence(
            row,
            'database',
            row.database_exists,
          );
          validateMetadataEvidence(row, 'role', row.role_exists);
          const databaseMetadata = parseMetadataComment(
            row.database_comment,
            DATABASE_METADATA_KINDS.database,
          );
          const roleMetadata = parseMetadataComment(
            row.role_comment,
            DATABASE_METADATA_KINDS.role,
          );
          if (
            databaseMetadata &&
            roleMetadata &&
            canonicalJson(databaseMetadata.marker) !==
              canonicalJson(roleMetadata.marker)
          ) {
            fail(
              'TENANT_DATABASE_METADATA_INVALID',
              'Tenant database and role lifecycle markers disagree.',
            );
          }
          return {
            databaseExists: row.database_exists,
            roleExists: row.role_exists,
            databaseOwnershipMarker:
              databaseMetadata?.ownershipMarker || null,
            roleOwnershipMarker: roleMetadata?.ownershipMarker || null,
            marker:
              databaseMetadata?.marker || roleMetadata?.marker || null,
          };
        } catch (error) {
          throw postgresError(error, signal);
        } finally {
          await boundedEndClient(client);
          signal.removeEventListener('abort', abort);
        }
      },
    });
  }

  async apply() {
    fail(
      'TENANT_DATABASE_MUTATION_DISABLED',
      'PostgreSQL lifecycle mutation is disabled in the inspect-only runtime.',
    );
  }

  async destroy() {
    fail(
      'TENANT_DATABASE_MUTATION_DISABLED',
      'PostgreSQL lifecycle destroy is disabled in the inspect-only runtime.',
    );
  }
}

class PostgresTenantLifecycleDestroyPort {
  constructor({ managementSecretProvider, Client, ca }) {
    if (
      !managementSecretProvider ||
      typeof managementSecretProvider.useManagementSecret !== 'function' ||
      typeof Client !== 'function' ||
      typeof ca !== 'string' ||
      ca.length < 100 ||
      ca.length > 1_000_000 ||
      !ca.includes('-----BEGIN CERTIFICATE-----')
    ) {
      fail(
        'TENANT_DATABASE_PROVIDER_INVALID',
        'The PostgreSQL destroy provider requires a management Secret provider and the RDS CA bundle.',
      );
    }
    this.managementSecretProvider = managementSecretProvider;
    this.Client = Client;
    this.ca = ca;
  }

  async inspect() {
    fail(
      'TENANT_LIFECYCLE_COMMAND_DISABLED',
      'The cleanup-only PostgreSQL provider cannot perform inspect tasks.',
    );
  }

  async apply() {
    fail(
      'TENANT_DATABASE_MUTATION_DISABLED',
      'Prepare, restore, migration, and verification remain disabled in production.',
    );
  }

  async destroy({ input, runtimeSecret, provisionPredecessor, signal }) {
    signal.throwIfAborted();
    if (
      input?.operation !== 'destroy' ||
      !input.provisionPredecessor ||
      canonicalJson(input.provisionPredecessor) !==
        canonicalJson(provisionPredecessor) ||
      !exactKeys(runtimeSecret, ['database_url'])
    ) {
      fail(
        'TENANT_DATABASE_CLEANUP_PREDECESSOR_MISMATCH',
        'The PostgreSQL destroy provider requires the exact parsed cleanup input and provision predecessor.',
      );
    }
    const databaseIdentifier = quoteTenantIdentifier(
      input.managementTarget.targetDatabaseName,
      'database',
    );
    const roleIdentifier = quoteTenantIdentifier(
      input.managementTarget.targetRoleName,
      'role',
    );
    const lockKey = canonicalJson({
      schemaVersion: 1,
      stableIdentity: input.stableIdentity,
      resourceGeneration: input.resourceGeneration,
    });

    return this.managementSecretProvider.useManagementSecret({
      input,
      signal,
      use: async (connection) => {
        const client = new this.Client({
          host: connection.host,
          port: connection.port,
          database: connection.database,
          user: connection.user,
          password: connection.password,
          ssl: Object.freeze({ ca: this.ca, rejectUnauthorized: true }),
          application_name: 'techlong-tenant-lifecycle-destroy',
          options: PG_DESTROY_STARTUP_OPTIONS,
          connectionTimeoutMillis: 10_000,
          query_timeout: 15_000,
          statement_timeout: 15_000,
          lock_timeout: 5_000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 1_000,
        });
        let lockHeld = false;
        let databaseDeletedThisCall = false;
        let roleDeletedThisCall = false;
        const abort = () => destroyClientStream(client);
        signal.addEventListener('abort', abort, { once: true });
        try {
          await client.connect();
          signal.throwIfAborted();
          const identityResult = await client.query({
            text: INSPECT_IDENTITY_SQL,
            values: [],
          });
          signal.throwIfAborted();
          const identity = identityResult?.rows?.[0];
          if (
            identityResult?.rowCount !== 1 ||
            !exactKeys(identity, [
              'management_database',
              'management_username',
              'management_port',
              'read_only',
              'tls_active',
            ]) ||
            identity.management_database !== connection.database ||
            identity.management_username !== connection.user ||
            Number(identity.management_port) !== connection.port ||
            identity.read_only !== 'off' ||
            identity.tls_active !== true
          ) {
            fail(
              'TENANT_DATABASE_CONNECTION_IDENTITY_MISMATCH',
              'PostgreSQL did not prove the exact TLS writable management connection.',
            );
          }
          await assertDestroyRegistryIdentity(client, connection, signal);
          const lockResult = await client.query({
            text: DESTROY_ADVISORY_LOCK_SQL,
            values: [lockKey],
          });
          signal.throwIfAborted();
          if (
            lockResult?.rowCount !== 1 ||
            !exactKeys(lockResult.rows?.[0], ['locked'])
          ) {
            fail(
              'TENANT_DATABASE_CLEANUP_LOCK_FAILED',
              'PostgreSQL did not acquire the exact lifecycle cleanup lock.',
              true,
            );
          }
          lockHeld = true;

          let state = await withPostgresTransaction(
            client,
            signal,
            async () => {
              const resources = await readDestroyResourceEvidence(
                client,
                input,
                signal,
              );
              let registry = await readDestroyRegistry(client, input, signal);
              if (registry === null) {
                if (!resources.databaseExists || !resources.roleExists) {
                  fail(
                    'TENANT_DATABASE_CLEANUP_PREDECESSOR_MISMATCH',
                    'Cleanup cannot adopt missing or partial resources without an exact durable registry record.',
                  );
                }
                registry = await insertDestroyRegistry(client, input, signal);
              } else {
                if (
                  (registry.databaseDeleted && resources.databaseExists) ||
                  (registry.roleDeleted && resources.roleExists) ||
                  (registry.lifecycleStatus === 'destroyed' &&
                    (resources.databaseExists || resources.roleExists)) ||
                  (resources.databaseExists && !resources.roleExists) ||
                  (registry.roleDeleted && !registry.databaseDeleted)
                ) {
                  fail(
                    'TENANT_DATABASE_CLEANUP_REGISTRY_INVALID',
                    'The lifecycle cleanup registry conflicts with the observed deletion order.',
                  );
                }
              }
              return { resources, registry };
            },
          );

          if (
            state.registry.lifecycleStatus === 'destroyed' &&
            !state.resources.databaseExists &&
            !state.resources.roleExists
          ) {
            return {
              outcome: 'already_missing',
              databaseDeleted: false,
              roleDeleted: false,
              predecessorMatched: true,
            };
          }

          let databaseDeleted =
            state.registry.databaseDeleted || !state.resources.databaseExists;
          let roleDeleted =
            state.registry.roleDeleted || !state.resources.roleExists;
          if (
            databaseDeleted !== state.registry.databaseDeleted ||
            roleDeleted !== state.registry.roleDeleted
          ) {
            state = {
              ...state,
              registry: await withPostgresTransaction(
                client,
                signal,
                () => updateDestroyRegistry(
                  client,
                  input,
                  { databaseDeleted, roleDeleted },
                  signal,
                ),
              ),
            };
          }
          if (databaseDeleted && roleDeleted) {
            return {
              outcome: 'already_missing',
              databaseDeleted: false,
              roleDeleted: false,
              predecessorMatched: true,
            };
          }

          if (!databaseDeleted) {
            await client.query({
              text: `REVOKE CONNECT ON DATABASE ${databaseIdentifier} FROM PUBLIC`,
              values: [],
            });
            signal.throwIfAborted();
            await client.query({
              text: `REVOKE CONNECT ON DATABASE ${databaseIdentifier} FROM ${roleIdentifier}`,
              values: [],
            });
            signal.throwIfAborted();
            await client.query({
              text: `ALTER DATABASE ${databaseIdentifier} WITH ALLOW_CONNECTIONS false`,
              values: [],
            });
            signal.throwIfAborted();
            await client.query({
              text: `SELECT pg_catalog.pg_terminate_backend(pid) AS terminated
                     FROM pg_catalog.pg_stat_activity
                     WHERE datname = $1
                       AND pid <> pg_catalog.pg_backend_pid()`,
              values: [input.managementTarget.targetDatabaseName],
            });
            signal.throwIfAborted();
            const remaining = await client.query({
              text: `SELECT pg_catalog.count(*)::integer AS active_connections
                     FROM pg_catalog.pg_stat_activity
                     WHERE datname = $1
                       AND pid <> pg_catalog.pg_backend_pid()`,
              values: [input.managementTarget.targetDatabaseName],
            });
            if (
              remaining?.rowCount !== 1 ||
              !exactKeys(remaining.rows?.[0], ['active_connections']) ||
              remaining.rows[0].active_connections !== 0
            ) {
              fail(
                'TENANT_DATABASE_CONNECTION_DRAIN_FAILED',
                'Tenant database sessions could not be terminated exactly.',
                true,
              );
            }
            await client.query({
              text: `DROP DATABASE ${databaseIdentifier}`,
              values: [],
            });
            signal.throwIfAborted();
            databaseDeleted = true;
            databaseDeletedThisCall = true;
            state = {
              ...state,
              registry: await withPostgresTransaction(
                client,
                signal,
                () => updateDestroyRegistry(
                  client,
                  input,
                  { databaseDeleted: true, roleDeleted },
                  signal,
                ),
              ),
            };
          }

          if (!roleDeleted) {
            await client.query({
              text: `DROP ROLE ${roleIdentifier}`,
              values: [],
            });
            signal.throwIfAborted();
            roleDeleted = true;
            roleDeletedThisCall = true;
          }
          if (
            state.registry.lifecycleStatus !== 'destroyed' ||
            !state.registry.databaseDeleted ||
            !state.registry.roleDeleted
          ) {
            state = {
              ...state,
              registry: await withPostgresTransaction(
                client,
                signal,
                () => updateDestroyRegistry(
                  client,
                  input,
                  { databaseDeleted: true, roleDeleted: true },
                  signal,
                ),
              ),
            };
          }
          const finalResources = await withPostgresTransaction(
            client,
            signal,
            () => readDestroyResourceEvidence(client, input, signal),
          );
          if (finalResources.databaseExists || finalResources.roleExists) {
            fail(
              'TENANT_DATABASE_DESTROY_UNVERIFIED',
              'PostgreSQL did not prove both exact tenant resources absent after destroy.',
              true,
            );
          }
          return {
            outcome:
              databaseDeletedThisCall || roleDeletedThisCall
                ? 'deleted'
                : 'already_missing',
            databaseDeleted:
              databaseDeletedThisCall || roleDeletedThisCall,
            roleDeleted:
              databaseDeletedThisCall || roleDeletedThisCall,
            predecessorMatched: true,
          };
        } catch (error) {
          throw postgresError(error, signal, 'destroy');
        } finally {
          if (lockHeld) {
            try {
              const unlockResult = await client.query({
                text: DESTROY_ADVISORY_UNLOCK_SQL,
                values: [lockKey],
              });
              if (
                unlockResult?.rowCount !== 1 ||
                !exactKeys(unlockResult.rows?.[0], ['unlocked']) ||
                unlockResult.rows[0].unlocked !== true
              ) {
                destroyClientStream(client);
              }
            } catch {
              destroyClientStream(client);
            }
          }
          await boundedEndClient(client);
          signal.removeEventListener('abort', abort);
        }
      },
    });
  }
}

function loadRdsCaBundle(readFileSync = fs.readFileSync) {
  let ca;
  try {
    ca = readFileSync(RDS_CA_BUNDLE_PATH, 'utf8');
  } catch {
    fail(
      'TENANT_DATABASE_RDS_CA_UNAVAILABLE',
      'The image-bundled AWS RDS CA bundle is unavailable.',
    );
  }
  if (
    typeof ca !== 'string' ||
    ca.length < 100 ||
    ca.length > 1_000_000 ||
    !ca.includes('-----BEGIN CERTIFICATE-----')
  ) {
    fail(
      'TENANT_DATABASE_RDS_CA_INVALID',
      'The image-bundled AWS RDS CA bundle is invalid.',
    );
  }
  return ca;
}

function defaultProductionReceiptDependencies() {
  const { S3Client, PutObjectCommand, GetObjectCommand } =
    require('@aws-sdk/client-s3');
  return { S3Client, PutObjectCommand, GetObjectCommand };
}

function defaultProductionExecutionDependencies() {
  const {
    SecretsManagerClient,
    GetSecretValueCommand,
  } = require('@aws-sdk/client-secrets-manager');
  const { Client } = require('pg');
  return {
    SecretsManagerClient,
    GetSecretValueCommand,
    Client,
    readFileSync: fs.readFileSync,
  };
}

function assertProductionCompositionInput(input) {
  if (!productionRuntimeModeForOperation(input?.operation)) {
    fail(
      'TENANT_LIFECYCLE_COMMAND_DISABLED',
      'Production lifecycle composition is available only for inspect and cleanup-only destroy.',
    );
  }
}

function assertProductionDependencies(sdk, names) {
  for (const name of names) {
    if (typeof sdk?.[name] !== 'function') {
      fail(
        'TENANT_LIFECYCLE_PROVIDER_INVALID',
        'Production lifecycle dependencies are incomplete.',
      );
    }
  }
}

function createProductionTenantLifecycleReceiptPublisher({
  input,
  dependencies,
}) {
  assertProductionCompositionInput(input);
  const sdk = dependencies || defaultProductionReceiptDependencies();
  assertProductionDependencies(sdk, [
    'S3Client',
    'PutObjectCommand',
    'GetObjectCommand',
  ]);
  const s3Client = new sdk.S3Client({
    region: input.aws.region,
    maxAttempts: 2,
  });
  return new TenantLifecycleReceiptPublisher({
    objectStore: new AwsSdkTenantLifecycleReceiptObjectStore({
      client: s3Client,
      region: input.aws.region,
      PutObjectCommand: sdk.PutObjectCommand,
      GetObjectCommand: sdk.GetObjectCommand,
    }),
  });
}

function createProductionTenantLifecycleExecutionComposition({
  input,
  dependencies,
}) {
  assertProductionCompositionInput(input);
  const sdk = dependencies || defaultProductionExecutionDependencies();
  assertProductionDependencies(sdk, [
    'SecretsManagerClient',
    'GetSecretValueCommand',
    'Client',
    'readFileSync',
  ]);
  const secretsClient = new sdk.SecretsManagerClient({
    region: input.aws.region,
    maxAttempts: 2,
  });
  const runtimeSecretProvider = new AwsSdkTenantRuntimeSecretProvider({
    client: secretsClient,
    GetSecretValueCommand: sdk.GetSecretValueCommand,
  });
  const managementSecretProvider = new AwsSdkTenantManagementSecretProvider({
    client: secretsClient,
    GetSecretValueCommand: sdk.GetSecretValueCommand,
  });
  const databaseProviderInput = {
    managementSecretProvider,
    Client: sdk.Client,
    ca: loadRdsCaBundle(sdk.readFileSync),
  };
  const databasePort = input.operation === 'inspect'
    ? new PostgresTenantLifecycleInspectPort(databaseProviderInput)
    : new PostgresTenantLifecycleDestroyPort(databaseProviderInput);
  return Object.freeze({
    secretProvider: runtimeSecretProvider,
    databasePort,
  });
}

function createProductionTenantLifecycleComposition({ input, dependencies }) {
  assertProductionCompositionInput(input);
  const sdk = dependencies || {
    ...defaultProductionReceiptDependencies(),
    ...defaultProductionExecutionDependencies(),
  };
  assertProductionDependencies(sdk, [
    'SecretsManagerClient',
    'GetSecretValueCommand',
    'S3Client',
    'PutObjectCommand',
    'GetObjectCommand',
    'Client',
    'readFileSync',
  ]);
  return Object.freeze({
    ...createProductionTenantLifecycleExecutionComposition({
      input,
      dependencies: sdk,
    }),
    receiptPublisher: createProductionTenantLifecycleReceiptPublisher({
      input,
      dependencies: sdk,
    }),
  });
}

module.exports = {
  DATABASE_METADATA_KINDS,
  DESTROY_ADVISORY_LOCK_SQL,
  DESTROY_ADVISORY_UNLOCK_SQL,
  DESTROY_REGISTRY_IDENTITY_SQL,
  DESTROY_REGISTRY_INSERT_SQL,
  DESTROY_REGISTRY_SELECT_SQL,
  DESTROY_REGISTRY_UPDATE_SQL,
  INSPECT_IDENTITY_SQL,
  INSPECT_RESOURCES_SQL,
  MANAGEMENT_SECRET_KEYS,
  MAX_DATABASE_METADATA_BYTES,
  PG_STARTUP_OPTIONS,
  POSTGRES_CLEANUP_TIMEOUT_MS,
  PRODUCTION_RUNTIME_MODE_BY_OPERATION,
  PG_DESTROY_STARTUP_OPTIONS,
  RDS_CA_BUNDLE_PATH,
  TENANT_LIFECYCLE_DESTROY_RUNTIME_MODE,
  TENANT_LIFECYCLE_INSPECT_RUNTIME_MODE,
  TENANT_LIFECYCLE_REGISTRY_COLUMN_IDENTITIES,
  TENANT_LIFECYCLE_REGISTRY_COLUMNS,
  TENANT_LIFECYCLE_REGISTRY_COMMENT,
  TENANT_LIFECYCLE_REGISTRY_CONSTRAINT_IDENTITIES,
  TENANT_LIFECYCLE_REGISTRY_GUARD_COMMENT,
  TENANT_LIFECYCLE_REGISTRY_GUARD_SOURCE,
  TENANT_LIFECYCLE_REGISTRY_INDEX_IDENTITIES,
  TENANT_LIFECYCLE_REGISTRY_TABLE,
  TENANT_LIFECYCLE_REGISTRY_TRIGGER_COMMENT,
  TENANT_LIFECYCLE_DEADLINE_MS,
  TENANT_LIFECYCLE_RUNTIME_MODE,
  AwsSdkTenantManagementSecretProvider,
  AwsSdkTenantRuntimeSecretProvider,
  PostgresTenantLifecycleDestroyPort,
  PostgresTenantLifecycleInspectPort,
  assertDestroyRegistryIdentity,
  assertProductionRuntimeEnvironment,
  boundedEndClient,
  createProductionTenantLifecycleComposition,
  createProductionTenantLifecycleExecutionComposition,
  createProductionTenantLifecycleReceiptPublisher,
  loadRdsCaBundle,
  parseMetadataComment,
  quoteTenantIdentifier,
  validateProductionInvocation,
};
