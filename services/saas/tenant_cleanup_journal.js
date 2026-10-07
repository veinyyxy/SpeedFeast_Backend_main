const {createHash}=require('node:crypto');
const {DESTROY_REGISTRY_IDENTITY_SQL}=require('./tenant_lifecycle_production');
const {TenantLifecycleContractError,canonicalJson}=require('./tenant_lifecycle_service');
const CLEANUP_JOURNAL='public.techlong_tenant_normal_cleanup_journal';
const CLEANUP_IDENTITY_SQL=DESTROY_REGISTRY_IDENTITY_SQL.replaceAll('techlong_tenant_lifecycle_registry','techlong_tenant_normal_cleanup_journal');
const CLEANUP_IDENTITY_SHA256='847a45554decbb5cb951d58fa290d2991d749e9b5b9fc8a0b21772f40c952f24';
const PREPARE_V2_IDENTITY_SHA256='7d08fae04b5e77a55085ccf4b4e06d44fa41a49e1dcc3630673fa31535113612';
async function cleanupJournalIdentity(client,signal){
  signal?.throwIfAborted();const result=await client.query(CLEANUP_IDENTITY_SQL);signal?.throwIfAborted();
  if(result.rowCount!==1||Buffer.byteLength(canonicalJson(result.rows[0]))>262144)
    throw new TenantLifecycleContractError('TENANT_NORMAL_CLEANUP_JOURNAL_INVALID','The complete cleanup journal identity is absent or unbounded.');
  for(const trigger of result.rows[0].triggers||[])if(typeof trigger.functionSource==='string')trigger.functionSource=trigger.functionSource.replace(/\r\n/g,'\n');
  return createHash('sha256').update(canonicalJson(result.rows[0])).digest('hex');
}
async function assertCleanupJournal(client,signal){
  if(await cleanupJournalIdentity(client,signal)!==CLEANUP_IDENTITY_SHA256)
    throw new TenantLifecycleContractError('TENANT_NORMAL_CLEANUP_JOURNAL_INVALID','Cleanup journal differs from its complete compiled identity.');
}
async function assertNamespaceReleased(client,input,signal){
  await assertCleanupJournal(client,signal);
  const result=await client.query({text:`SELECT EXISTS(SELECT 1 FROM public.techlong_tenant_prepare_journal p
    WHERE (p.database_name=$1 OR p.role_name=$2) AND (
      p.stable_identity<>$3 OR p.hash_prefix<>$4 OR p.generation>=$5 OR p.phase NOT IN ('prepared','compensated') OR
      (p.phase='prepared' AND NOT EXISTS(SELECT 1 FROM ${CLEANUP_JOURNAL} c WHERE c.stable_identity=p.stable_identity
        AND c.generation=p.generation AND c.hash_prefix=p.hash_prefix AND c.ownership_marker=p.ownership_marker
        AND c.database_name=p.database_name AND c.role_name=p.role_name AND c.database_oid=p.database_oid AND c.role_oid=p.role_oid
        AND c.provision_epoch=p.external_epoch AND c.provision_marker=p.external_marker AND c.provision_hash=p.external_hash
        AND c.phase='destroyed' AND c.database_deleted AND c.role_deleted)))) AS blocked`,
    values:[input.managementTarget.targetDatabaseName,input.managementTarget.targetRoleName,input.stableIdentity,input.stableIdentityHashPrefix,input.resourceGeneration]});
  signal?.throwIfAborted();
  if(result.rowCount!==1||result.rows[0].blocked!==false)
    throw new TenantLifecycleContractError('TENANT_PREPARE_RELEASE_UNPROVEN','Every earlier namespace slot must be exactly and permanently released.');
}
async function assertProvisionNotCleaning(client,input,signal){
  await assertCleanupJournal(client,signal);
  const result=await client.query({text:`SELECT EXISTS(SELECT 1 FROM ${CLEANUP_JOURNAL} WHERE stable_identity=$1 AND generation=$2) AS claimed`,
    values:[input.stableIdentity,input.resourceGeneration]});signal?.throwIfAborted();
  if(result.rowCount!==1||result.rows[0].claimed!==false)
    throw new TenantLifecycleContractError('TENANT_PROVISION_RETIRED','A cleanup claim permanently closes this provision generation.');
}
module.exports={CLEANUP_JOURNAL,CLEANUP_IDENTITY_SQL,CLEANUP_IDENTITY_SHA256,PREPARE_V2_IDENTITY_SHA256,
  cleanupJournalIdentity,assertCleanupJournal,assertNamespaceReleased,assertProvisionNotCleaning};
