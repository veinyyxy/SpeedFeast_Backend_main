'use strict';
// Image-load and pure ACL/classification checks only, no archive or network.
const assert=require('node:assert/strict');
const a=require('./aurora-express-application-v6.cjs');
function check(){
  const role={oid:'16456',name:a.TARGET.role,login:false,inherit:false,superuser:false,create_db:false,create_role:false,
    replication:false,bypass_rls:false,settings:false,owns_objects:false,connection_limit:-1,valid_until:null,config:null,
    parents:[],members:[],iam_role_oid:'19000',other_connectable_databases:1};
  assert.equal(a.classifyApplicationRoleV6({rowCount:1,rows:[role]},'closed').state,'CLOSED_REQUIRES_ISOLATION_REVIEW');
  assert.throws(()=>a.assertCompiledApplicationCandidateV6({}));
  assert.equal(typeof a.activate,'undefined');assert.equal(typeof a.run,'undefined');
  return {schema:'techlong/express-application-image-check/v6',candidateOnly:true,
    isolationRequiredBeforeLogin:true,serializedProgramRejected:true,executionRootAvailable:false,
    awsCalls:0,sqlConnections:0,runtimeEnabled:false,liveApplicationLoginVerified:false};
}
if(require.main===module){try{process.stdout.write(JSON.stringify(check())+'\n');}catch{process.stderr.write('AURORA_APP_V6_IMAGE_CHECK_FAILED\n');process.exitCode=1;}}
module.exports={check};
