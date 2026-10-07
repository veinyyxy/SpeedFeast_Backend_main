// Compiled management catalog reads only, called between (not inside) durable
// journal transactions. SET LOCAL cannot leak a different search_path to the
// borrowed session. pg_get_constraintdef's qualified names must be stable.
async function readJournalCatalog(client,sql,signal){
  signal?.throwIfAborted();await client.query('BEGIN READ ONLY');
  try{
    await client.query('SET LOCAL search_path = pg_catalog, public');
    const result=await client.query(sql);signal?.throwIfAborted();
    await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK').catch(()=>client.connection?.stream?.destroy());throw e;}
}
module.exports={readJournalCatalog};
