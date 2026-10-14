'use strict';
// Standalone C2b observability adapter. Preserve the approved C2a inspector,
// its fixed SQL/TLS checks and old code pins; never become a lifecycle writer.
const { performance } = require('node:perf_hooks');
const { inspectExpressAdminC2, validateAdminTarget, ADMIN_SQL } = require('./aurora_express_admin_probe');
const { READ_IDENTITY_SQL } = require('./aurora_connections_v2');
const { digest } = require('./database_contract_v2.cjs');
const NETWORK_CODES = Object.freeze(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'EPIPE']);
const TLS_CODES = Object.freeze(['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_UNTRUSTED', 'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION']);
const PG_CODES = Object.freeze(['28000', '28P01', '3D000', '42501', '42601', '42703', '57014',
  '25P02', '25006', '08P01', '08001', '08003', '08006', '08004', '57P01', '57P02', '57P03']);
const STAGES = Object.freeze(['connect', 'dns', 'tcp', 'pg_ssl', 'tls', 'auth', 'credentials', 'signing',
  'sql_1', 'sql_2', 'sql_3', 'sql_4', 'dispose', 'finished']);
const SQL = Object.freeze(['BEGIN READ ONLY', READ_IDENTITY_SQL, ADMIN_SQL, 'COMMIT']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
function classifyDiagnosticError(error) {
  if (NETWORK_CODES.includes(error?.code)) return { category: 'network', code: error.code };
  if (TLS_CODES.includes(error?.code)) return { category: 'tls', code: error.code };
  if (PG_CODES.includes(error?.code)) return { category: 'postgres', code: error.code };
  // Compare exact known driver strings; never return any supplied text.
  if (['timeout expired', 'Connection terminated due to connection timeout'].includes(error?.message))
    return { category: 'timeout', code: 'PG_CONNECT_TIMEOUT' };
  if (error?.message === 'Query read timeout') return { category: 'timeout', code: 'PG_QUERY_TIMEOUT' };
  if (error?.message === 'The server does not support SSL connections') return { category: 'tls', code: 'PG_SSL_NOT_SUPPORTED' };
  if (error?.message === 'There was an error establishing an SSL connection') return { category: 'tls', code: 'PG_SSL_NEGOTIATION_FAILED' };
  if (['Connection terminated', 'Connection terminated unexpectedly'].includes(error?.message))
    return { category: 'network', code: 'PG_CONNECTION_TERMINATED' };
  if (error?.name === 'AbortError') return { category: 'cancelled', code: 'ABORTED' };
  return { category: 'unknown', code: 'OTHER_DRIVER_ERROR' };
}
async function diagnoseExpressAdminC2({ target, credentialProvider, signal, onEvent, dependencies = {} }) {
  const t = validateAdminTarget(target);
  if (typeof credentialProvider !== 'function' || typeof onEvent !== 'function' || !signal?.throwIfAborted)
    fail('EXPRESS_C2B_EXPLICIT_SOURCE_AND_JOURNAL_REQUIRED');
  signal.throwIfAborted();
  const Client = dependencies.Client || require('pg').Client;
  const Signer = dependencies.Signer || require('@aws-sdk/rds-signer').Signer;
  const started = performance.now(), frames = [];
  let firstError = null, lastStage = 'connect', clients = 0, connections = 0, signatures = 0, statements = 0;
  const record = (stage, event, error) => {
    if (!STAGES.includes(stage) || !['start', 'ok', 'observed', 'error'].includes(event) || frames.length >= 64)
      fail('EXPRESS_C2B_EVENT_BOUNDS_EXCEEDED');
    lastStage = stage;
    const safeError = error ? classifyDiagnosticError(error) : null;
    if (safeError && !firstError) firstError = safeError;
    const frame = Object.freeze({ sequence: frames.length + 1, elapsedMs: Math.floor(performance.now() - started),
      stage, event, error: safeError && Object.freeze(safeError) });
    frames.push(frame); onEvent(frame); // Root journals only this detached whitelist object.
  };
  class ObservedClient extends Client {
    constructor(config) {
      if (++clients !== 1) fail('EXPRESS_C2B_SECOND_CLIENT_DENIED');
      super({ ...config, connectionTimeoutMillis: 30000 });
      const connection = this.connection, stream = connection?.stream;
      stream?.on?.('lookup', error => record('dns', error ? 'error' : 'observed', error));
      stream?.once?.('connect', () => record('tcp', 'ok'));
      connection?.once?.('connect', () => record('pg_ssl', 'start'));
      connection?.once?.('sslconnect', () => {
        record('tls', 'start');
        connection.stream?.once?.('secureConnect', () => record('tls', 'observed'));
      });
      for (const challenge of ['authenticationCleartextPassword', 'authenticationMD5Password', 'authenticationSASL'])
        connection?.once?.(challenge, () => record('auth', 'start'));
      connection?.once?.('readyForQuery', () => record('auth', 'ok'));
      this.on('error', error => record(lastStage, 'error', error));
    }
    async connect() {
      if (++connections !== 1) fail('EXPRESS_C2B_SECOND_CONNECTION_DENIED');
      record('connect', 'start');
      try { await super.connect(); record('connect', 'ok'); }
      catch (e) { record(lastStage, 'error', e); throw e; }
    }
    async query(sql) {
      if (sql !== SQL[statements] || statements >= 4) fail('EXPRESS_C2B_SQL_NOT_FIXED');
      const stage = `sql_${++statements}`;
      record(stage, 'start');
      try { const result = await super.query(sql); record(stage, 'ok'); return result; }
      catch (e) { record(stage, 'error', e); throw e; }
    }
    async end() { record('dispose', 'start'); await super.end(); record('dispose', 'ok'); }
  }
  class ObservedSigner extends Signer {
    async getAuthToken() {
      if (++signatures !== 1) fail('EXPRESS_C2B_SECOND_SIGNATURE_DENIED');
      record('signing', 'start');
      try { const token = await super.getAuthToken(); record('signing', 'ok'); return token; }
      catch (e) { record('signing', 'error', e); throw e; }
    }
  }
  const source = async () => {
    record('credentials', 'start');
    try { const value = await credentialProvider(); record('credentials', 'ok'); return value; }
    catch (e) { record('credentials', 'error', e); throw e; }
  };
  let observation = null, stopped = false;
  try {
    observation = await inspectExpressAdminC2({ target: t, credentialProvider: source, signal,
      dependencies: { ...dependencies, Client: ObservedClient, Signer: ObservedSigner } });
  } catch { stopped = true; }
  const failureStage = stopped ? frames.find(f => f.event === 'error')?.stage ||
    [...frames].reverse().find(f => !['dispose', 'finished'].includes(f.stage))?.stage || 'connect' : null;
  record('finished', stopped ? 'error' : 'ok');
  return Object.freeze({ schema: 'techlong/express-admin-diagnostic/c2b', targetSha256: digest(t),
    outcome: stopped ? 'READONLY_DIAGNOSTIC_STOPPED' : 'ADMIN_READONLY_OBSERVED_NOT_TENANT_VERIFIED',
    failureStage, failure: stopped ? firstError || { category: 'unknown', code: 'INSPECTOR_SCOPE_OR_IDENTITY_UNPROVEN' } : null,
    events: Object.freeze(frames), observation, attempts: { clients, connections, signatures, statements },
    connectTimeoutMs: 30000, rawErrorsIncluded: false, sqlMutationPerformed: false, runtimeEnabled: false, lifecycleCompatible: false });
}
module.exports = { classifyDiagnosticError, diagnoseExpressAdminC2, STAGES };
