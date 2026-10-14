'use strict';
// Exact continuation from C3c's existing reserved roles. Never creates/adopts
// another role, installs membership or replays a completed reserve stage.
const { CATALOG_SQL: OLD_SQL } = require('./aurora_express_bootstrap_provider_v3');
const c = require('./aurora-express-continuation-v4.cjs');
const fail = code => { throw Object.assign(new Error(code), { code, retryable: false }); };
const CATALOG_SQL = OLD_SQL
  .replace("'members',COALESCE", "'memberCount',(SELECT count(*)::integer FROM pg_auth_members WHERE roleid=r.oid),'members',COALESCE")
  .replace("'name',pg_get_userbyid(m.member),'grantor'", "'memberOid',m.member::text,'grantorOid',m.grantor::text,'name',pg_get_userbyid(m.member),'grantor'")
  .replace('WHERE roleid=r.oid LIMIT 3', 'WHERE roleid=r.oid ORDER BY member,grantor LIMIT 2');
if (CATALOG_SQL === OLD_SQL || !CATALOG_SQL.includes("'memberCount'") || !CATALOG_SQL.includes("'memberOid'") ||
  CATALOG_SQL.includes('LIMIT 3')) fail('AURORA_V4_CATALOG_SOURCE_REJECTED');
async function observe(client, program, signal) {
  signal.throwIfAborted();
  const r = await client.query({ text: CATALOG_SQL, values: [[program.target.tenantUsername,program.guardName],program.target.tenantDatabase] });
  signal.throwIfAborted(); const row = r.rows?.[0];
  if (r.rowCount !== 1 || !Array.isArray(row?.roles) || row.roles.length > 2 || !Array.isArray(row.databases) ||
    row.databases.length > 1 || Buffer.byteLength(c.canonical(row)) > 65536) fail('AURORA_V4_CATALOG_REJECTED');
  return { raw: row, app: row.roles.find(a => a.name === program.target.tenantUsername) || null,
    guard: row.roles.find(a => a.name === program.guardName) || null, database: row.databases[0] || null };
}
class PostgresExpressContinuationProviderV4 {
  #program;
  constructor(program) { this.#program = c.assertCompiledContinuationV4(program); }
  async prepare({ sessions, managementDatabaseOid, managementRoleOid, signal, journal }) {
    const p = this.#program;
    if (managementDatabaseOid !== '5' || managementRoleOid !== p.predecessor.managementRoleOid ||
      typeof sessions?.withManagement !== 'function' || !signal?.throwIfAborted ||
      ['beforeStage','stageObserved','stageFailed'].some(k => typeof journal?.[k] !== 'function')) fail('AURORA_V4_REVIEWED_ROOT_REQUIRED');
    return sessions.withManagement({ managementDatabaseOid,managementRoleOid,signal,use: async (client,connection) => {
      if (connection.targetSha256 !== p.targetSha256 || connection.roleOid !== managementRoleOid) fail('AURORA_V4_SESSION_CHANGED');
      const key = c.canonical({ schema: 'techlong/express-bootstrap-lock/v3',stableIdentity:p.target.stableIdentity,generation:1 });
      const locked = await client.query({ text:'SELECT pg_try_advisory_lock(hashtextextended($1::text,0)) AS locked',values:[key] });
      if (locked.rowCount !== 1 || locked.rows?.[0]?.locked !== true) fail('AURORA_V4_LOCK_BUSY');
      let phase = 'reserved-check';
      try {
        let current = await observe(client,p,signal); c.verifyStageV4(p,current,'reserved');
        if (c.originalCatalogDigest(current.raw) !== p.predecessor.reservedCatalogSha256) fail('AURORA_V4_RESERVED_CATALOG_DRIFT');
        for (const stage of p.stages) {
          phase = stage.name;
          await journal.beforeStage({ stage:phase,programSha256:c.digest(p),priorCatalogSha256:c.digest(current.raw),statements:stage.statements.length });
          const before = current;
          for (const text of stage.statements) { signal.throwIfAborted(); await client.query(text); signal.throwIfAborted(); }
          current = await observe(client,p,signal); c.verifyStageV4(p,current,phase,before);
          await journal.stageObserved({ stage:phase,catalogSha256:c.digest(current.raw),roleOid:current.app.oid,
            guardOid:current.guard?.oid || null,databaseOid:current.database.oid });
        }
        return Object.freeze({ schema:'techlong/express-continuation-observation/v4',programSha256:c.digest(p),
          targetSha256:p.targetSha256,rolePolicySha256:p.rolePolicySha256,predecessorFileSha256:p.predecessor.diagnosticFileSha256,
          roleOid:current.app.oid,databaseOid:current.database.oid,state:p.terminalState,mutationPerformed:true,
          loginEnabled:false,baselineRestored:false,runtimeEnabled:false,lifecycleCompatible:false });
      } catch (error) {
        try { await journal.stageFailed({ stage:phase,safeCode:c.safeFailure(error) }); } catch { /* preserve original failure; no write replay */ }
        throw error;
      } finally {
        try { const r = await client.query({ text:'SELECT pg_advisory_unlock(hashtextextended($1::text,0)) AS unlocked',values:[key] });
          if (r.rows?.[0]?.unlocked !== true) client.connection?.stream?.destroy(); }
        catch { client.connection?.stream?.destroy(); }
      }
    } });
  }
}
module.exports = { PostgresExpressContinuationProviderV4,CATALOG_SQL,observe };
