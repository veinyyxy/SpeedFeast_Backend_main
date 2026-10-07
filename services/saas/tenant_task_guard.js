const {TenantLifecycleContractError}=require('./tenant_lifecycle_service');
const {TENANT_LIFECYCLE_DEADLINE_MS}=require('./tenant_lifecycle_production');
const TENANT_LIFECYCLE_ABORT_GRACE_MS=5000;
const TENANT_LIFECYCLE_HARD_TIMEOUT_ERROR='TENANT_LIFECYCLE_TASK_HARD_TIMEOUT: tenant lifecycle task failed closed\n';
function createTenantLifecycleTaskGuard({deadlineMs=TENANT_LIFECYCLE_DEADLINE_MS,abortGraceMs=TENANT_LIFECYCLE_ABORT_GRACE_MS,
  setTimer=setTimeout,clearTimer=clearTimeout,hardExit=code=>process.exit(code),writeError=message=>process.stderr.write(message)}={}){
  const controller=new AbortController();let completed=false,watchdog;
  const abort=reason=>{
    if(completed)return;
    if(!controller.signal.aborted)controller.abort(reason);
    if(watchdog!==undefined)return;
    watchdog=setTimer(()=>{if(!completed){try{writeError(TENANT_LIFECYCLE_HARD_TIMEOUT_ERROR);}finally{hardExit(1);}}},abortGraceMs);
  };
  const deadline=setTimer(()=>abort(new TenantLifecycleContractError('TENANT_LIFECYCLE_TASK_DEADLINE_EXCEEDED','The lifecycle task exceeded its fixed deadline.',true)),deadlineMs);
  return Object.freeze({signal:controller.signal,
    abortForSignal:()=>abort(new TenantLifecycleContractError('TENANT_LIFECYCLE_TASK_ABORTED','The lifecycle task was interrupted.',true)),
    complete(){if(completed)return;completed=true;clearTimer(deadline);if(watchdog!==undefined)clearTimer(watchdog);}});
}
module.exports={createTenantLifecycleTaskGuard,TENANT_LIFECYCLE_ABORT_GRACE_MS,TENANT_LIFECYCLE_HARD_TIMEOUT_ERROR};
