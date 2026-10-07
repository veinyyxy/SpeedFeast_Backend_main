const {createHash}=require('node:crypto');
const {canonicalJson,TenantLifecycleContractError}=require('./tenant_lifecycle_service');

// One reviewed schema-only candidate. New archive/manifest pairs require a new
// code-reviewed catalog pin, not caller-provided fingerprints or auto-learning.
const BASELINE_CATALOG_PINS=Object.freeze({
  archiveSha256:'1a65288b4628018932a8d9af4658db5702b6cf49966a2032bc2d919bc591d70a',
  manifestSha256:'62b5dc8cadcf276df140be86e002a08b64d9b713bd0257e14ac515c12a996971',
  catalogSha256:'d27dc20410e0cceac97a49bfd72a0bcc7fa197b25d512d2b941df0a70ae1d55b',
});
const CATALOG_SQL=`WITH user_ns AS (
  SELECT * FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema')
    AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'
), functions AS (
  SELECT p.*,n.nspname,EXISTS(SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
    WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_extension'::regclass
      AND d.deptype='e' AND e.extname='uuid-ossp') AS extension_owned
  FROM pg_catalog.pg_proc p JOIN user_ns n ON n.oid=p.pronamespace
)
SELECT jsonb_build_object(
  'schemas',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',n.nspname,'owner',pg_get_userbyid(n.nspowner),
    'acl',COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
      ORDER BY a.grantee,a.privilege_type) FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a),'[]'::jsonb))
    ORDER BY n.nspname) FROM user_ns n),'[]'::jsonb),
  'relations',COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,
    'owner',pg_get_userbyid(c.relowner),'persistence',c.relpersistence,'options',c.reloptions,'rls',c.relrowsecurity,
    'forceRls',c.relforcerowsecurity,'replicaIdentity',c.relreplident,
    'acl',COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
      ORDER BY a.grantee,a.privilege_type) FROM aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a),'[]'::jsonb),
    'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object('position',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'notNull',a.attnotnull,'dropped',a.attisdropped,'identity',a.attidentity,'generated',a.attgenerated,'dimensions',a.attndims,
      'storage',a.attstorage,'acl',a.attacl::text,'collation',cn.nspname||'.'||coll.collname,'default',pg_get_expr(d.adbin,d.adrelid,false))
      ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      LEFT JOIN pg_collation coll ON coll.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=coll.collnamespace
      WHERE a.attrelid=c.oid AND a.attnum>0),'[]'::jsonb),
    'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'definition',pg_get_constraintdef(x.oid,false),
      'validated',x.convalidated,'deferrable',x.condeferrable,'deferred',x.condeferred,'noInherit',x.connoinherit,
      'local',x.conislocal,'inheritance',x.coninhcount) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),'[]'::jsonb),
    'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid,0,false),
      'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,
      'nullsNotDistinct',i.indnullsnotdistinct,'replicaIdentity',i.indisreplident) ORDER BY ic.relname)
      FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),'[]'::jsonb),
    'sequence',(SELECT jsonb_build_object('type',format_type(s.seqtypid,NULL),'start',s.seqstart::text,'increment',s.seqincrement::text,
      'min',s.seqmin::text,'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle) FROM pg_sequence s WHERE s.seqrelid=c.oid),
    'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',CASE WHEN t.tgisinternal THEN NULL ELSE t.tgname END,
      'internal',t.tgisinternal,'type',t.tgtype,'enabled',t.tgenabled,'args',encode(t.tgargs,'hex'),'columns',t.tgattr::text,
      'when',pg_get_expr(t.tgqual,t.tgrelid,false),'function',pn.nspname||'.'||p.proname,
      'constraint',x.conname,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,
      'definition',CASE WHEN t.tgisinternal THEN NULL ELSE pg_get_triggerdef(t.oid,false) END)
      ORDER BY t.tgisinternal,x.conname,pn.nspname,p.proname,t.tgtype,t.tgattr::text)
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
      LEFT JOIN pg_constraint x ON x.oid=t.tgconstraint WHERE t.tgrelid=c.oid),'[]'::jsonb),
    'rules',COALESCE((SELECT jsonb_agg(pg_get_ruledef(r.oid,false) ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb),
    'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
      'roles',(SELECT jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END ORDER BY role_oid) FROM unnest(p.polroles) role_oid),
      'using',pg_get_expr(p.polqual,p.polrelid,false),'check',pg_get_expr(p.polwithcheck,p.polrelid,false)) ORDER BY p.polname)
      FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb)) ORDER BY n.nspname,c.relname)
    FROM pg_class c JOIN user_ns n ON n.oid=c.relnamespace),'[]'::jsonb),
  'functions',COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',p.nspname,'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),
    'definition',pg_get_functiondef(p.oid),'owner',CASE WHEN p.extension_owned THEN 'EXTENSION_SCRIPT_OWNER' ELSE pg_get_userbyid(p.proowner) END,
    'kind',p.prokind,'volatility',p.provolatile,'parallel',p.proparallel,'securityDefiner',p.prosecdef,'leakproof',p.proleakproof,
    'strict',p.proisstrict,'config',p.proconfig,'extensionOwned',p.extension_owned,
    'acl',COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC'
      WHEN p.extension_owned AND a.grantee=p.proowner THEN 'EXTENSION_SCRIPT_OWNER' ELSE pg_get_userbyid(a.grantee) END,
      'grantor',CASE WHEN p.extension_owned AND a.grantor=p.proowner THEN 'EXTENSION_SCRIPT_OWNER' ELSE pg_get_userbyid(a.grantor) END,
      'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type)
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a),'[]'::jsonb))
    ORDER BY p.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) FROM functions p),'[]'::jsonb),
  'extensions',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname,
    'owner',pg_get_userbyid(e.extowner),'relocatable',e.extrelocatable,'config',e.extconfig::text,'condition',e.extcondition)
    ORDER BY e.extname) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname<>'plpgsql'),'[]'::jsonb),
  'types',COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',t.typname,'kind',t.typtype,'owner',pg_get_userbyid(t.typowner),
    'notNull',t.typnotnull,'default',t.typdefault,'acl',t.typacl::text,'enum',COALESCE((SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
      FROM pg_enum e WHERE e.enumtypid=t.oid),'[]'::jsonb)) ORDER BY n.nspname,t.typname)
    FROM pg_type t JOIN user_ns n ON n.oid=t.typnamespace),'[]'::jsonb),
  'collations',COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.collname,'provider',c.collprovider,
    'deterministic',c.collisdeterministic,'encoding',c.collencoding,'collate',c.collcollate,'ctype',c.collctype,'icu',c.colliculocale,'version',c.collversion)
    ORDER BY n.nspname,c.collname) FROM pg_collation c JOIN user_ns n ON n.oid=c.collnamespace),'[]'::jsonb),
  'eventTriggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',e.evtname,'event',e.evtevent,'enabled',e.evtenabled,
    'owner',pg_get_userbyid(e.evtowner),'function',e.evtfoid::regprocedure::text,'tags',e.evttags) ORDER BY e.evtname)
    FROM pg_event_trigger e),'[]'::jsonb)
) AS identity`;

async function baselineCatalogIdentity(client,signal) {
  signal?.throwIfAborted();
  await client.query('SET LOCAL search_path = pg_catalog');
  const result=await client.query(CATALOG_SQL);signal?.throwIfAborted();
  if(result.rowCount!==1||!result.rows[0]?.identity||Buffer.byteLength(canonicalJson(result.rows[0].identity))>4_000_000)
    throw new TenantLifecycleContractError('TENANT_BASELINE_CATALOG_INVALID','The bounded tenant schema catalog is invalid.');
  return createHash('sha256').update(canonicalJson(result.rows[0].identity)).digest('hex');
}
module.exports={BASELINE_CATALOG_PINS,CATALOG_SQL,baselineCatalogIdentity};
