'use strict';
// Same real archive/private brand compilation; only the new admission port.
const {compile:compileV4}=require('./prepare-aurora-express-sql-v4');
const {PostgresExpressRestoreProviderV5}=require('../services/saas/aurora_express_restore_v5');
async function compile(options) {
  const built=await compileV4(options);
  const provider=new PostgresExpressRestoreProviderV5({bootstrapProgram:built.bootstrap,baselineProgram:built.baseline});
  return {...built,provider,identity:provider.programIdentity()};
}
module.exports={compile};
