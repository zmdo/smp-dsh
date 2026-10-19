import type { LoadedScript } from './recipe.ts'
import { quote } from './recipe.ts'
import type { SshSession } from './ssh.ts'
import type { TypeLease } from './registry.ts'
import { environment, type PreparedPlan } from './plans.ts'
import { ServerError } from './i18n.ts'

/** A root-owned journal and flock survive SSH disconnects. An unknown result never authorizes replay. */
export const REMOTE_SUPERVISOR = String.raw`
import os,sys,json,fcntl,subprocess,uuid,time,selectors,tempfile
ROOT='/var/lib/smp-server-management'
def emit(value): print(json.dumps(value),flush=True)
def write(path,value):
 temp=path+'.tmp';fd=os.open(temp,os.O_CREAT|os.O_TRUNC|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f: json.dump(value,f);f.flush();os.fsync(f.fileno())
 os.replace(temp,path)
def read(path):
 with open(path) as f:return json.load(f)
def command(script):
 if script['interpreter']!='posix-sh':raise RuntimeError('unsupported_interpreter')
 return ['sh','-c',script['body']]
def run(script,request):
 # Keep draining bounded output while a package manager finishes; never kill it at an arbitrary timeout.
 with tempfile.TemporaryFile() as incoming:
  incoming.write(json.dumps(request).encode());incoming.seek(0)
  p=subprocess.Popen(command(script),stdin=incoming,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  selector=selectors.DefaultSelector();selector.register(p.stdout,selectors.EVENT_READ,'out');selector.register(p.stderr,selectors.EVENT_READ,'err')
  out=b'';err=b'';overflow=False;limit=script['outputLimitBytes']
  while selector.get_map():
   for key,_ in selector.select(1):
    chunk=os.read(key.fileobj.fileno(),65536)
    if not chunk:selector.unregister(key.fileobj);key.fileobj.close();continue
    if key.data=='out':
     if len(out)+len(chunk)>limit:overflow=True
     out=(out+chunk)[:limit]
    else:err=(err+chunk)[-min(limit,4096):]
  selector.close();code=p.wait()
  if code or overflow:raise RuntimeError('recipe_failed: '+err.decode(errors='replace')[-500:])
  return json.loads(out)
def worker(request,path,lock):
 record=dict(state='running',digest=request['digest'],steps=[])
 write(path+'/result.json',record)
 try:
  for index,step in enumerate(request['steps']):
   change=step['request']['change'];result=dict(ordinal=index+1,software=change['software'],state='running',changes=[])
   record['steps'].append(result);write(path+'/result.json',record)
   observed=run(step['detect'],dict(step['environment'],operation='detect'))
   actual=observed.get('result',{})
   if observed.get('operation')!='detect':raise RuntimeError('invalid_detection')
   target=change.get('target')
   satisfied=actual.get('state')=='installed' and actual.get('healthy') and target and actual.get('targetIdentity')==target['targetIdentity']
   if change['action'] in ('keep','defer-install'):
    if actual!=change['before']:raise RuntimeError('software_drift')
    result.update(state='succeeded',after=actual)
   else:
    if not satisfied:
     if actual!=change['before']:raise RuntimeError('software_drift')
     execution=run(step['execute'],dict(step['request'],operation='execute'))
     result['changes']=execution.get('changes',[]);write(path+'/result.json',record)
     if execution.get('operation')!='execute' or execution.get('state')!='completed':raise RuntimeError('execution_failed')
    verification=run(step['verify'],dict(step['request'],operation='verify'))
    result['after']=verification.get('result')
    after=result['after'] or {}
    if verification.get('operation')!='verify' or not verification.get('healthy') or after.get('state')!='installed' or not after.get('healthy') or after.get('targetIdentity')!=target['targetIdentity']:raise RuntimeError('verification_failed')
    result['state']='succeeded'
   write(path+'/result.json',record)
  record['state']='completed'
 except Exception as e:
  record.update(state='failed',error=str(e)[-500:])
  if record['steps']:
   record['steps'][-1]['state']='failed'
   try:
    observation=run(step['detect'],dict(step['environment'],operation='detect'))
    if observation.get('operation')=='detect':record['steps'][-1]['after']=observation.get('result')
   except Exception as detection_error:record['steps'][-1]['observationError']=str(detection_error)[-500:]
 finally:
  write(path+'/result.json',record);os.close(lock)
def main():
 if os.geteuid()!=0:raise RuntimeError('root_required')
 os.umask(0o077);os.makedirs(ROOT,mode=0o700,exist_ok=True)
 st=os.lstat(ROOT)
 if not __import__('stat').S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o077:raise RuntimeError('unsafe_journal_directory')
 request=json.load(sys.stdin);operation=str(uuid.UUID(request['operationId']));path=ROOT+'/'+operation
 lock=os.open(ROOT+'/lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);locked=True
 except BlockingIOError:locked=False
 resultpath=path+'/result.json'
 if os.path.exists(resultpath):
  result=read(resultpath)
  if result.get('digest')!=request['digest']:raise RuntimeError('operation_identity_conflict')
  if result['state']=='running' and locked:result['state']='unknown'
  emit(result);os.close(lock);return
 if request['operation']=='recover':emit(dict(state='unknown' if os.path.exists(path) or not locked else 'not-started',steps=[]));os.close(lock);return
 if not locked:raise RuntimeError('remote_busy')
 activepath=ROOT+'/active'
 if os.path.exists(activepath):
  previous=read(activepath)['operationId'];previouspath=ROOT+'/'+str(uuid.UUID(previous))+'/result.json'
  if not os.path.exists(previouspath) or read(previouspath)['state']=='running':raise RuntimeError('previous_operation_unresolved')
 os.mkdir(path,0o700);write(path+'/request.json',request);write(activepath,dict(operationId=operation))
 write(path+'/result.json',dict(state='running',digest=request['digest'],steps=[]))
 pid=os.fork()
 if pid==0:
  os.setsid()
  null=os.open('/dev/null',os.O_RDWR)
  for fd in (0,1,2):os.dup2(null,fd)
  os.close(null)
  worker(request,path,lock);os._exit(0)
 emit(dict(state='running',digest=request['digest'],steps=[]));os.close(lock)
try:main()
except Exception as e:print(str(e)[-500:],file=sys.stderr);sys.exit(1)
`
export interface RemoteResult {
  state: 'not-started' | 'running' | 'completed' | 'failed' | 'unknown'
  steps: Array<{ ordinal: number; software: string; state: string; changes: unknown[]; after?: unknown }>
  error?: string
}
export async function remoteOperation(
  session: SshSession,
  operation: 'start' | 'recover',
  operationId: string,
  digest: string,
  plan?: PreparedPlan,
  lease?: TypeLease,
): Promise<RemoteResult> {
  const steps =
    operation === 'start'
      ? plan!.changes.map((change, index) => {
          const component = lease!.components[index]!
          return {
            environment: environment(component, plan!.os),
            request: { ...environment(component, plan!.os), operationId, planDigest: digest, change },
            detect: component.scripts.detect,
            execute: component.scripts.execute,
            verify: component.scripts.verify,
          }
        })
      : undefined
  const command = `${'sudo -n '}python3 -c ${quote(REMOTE_SUPERVISOR)}`
  // Root hosts do not necessarily have sudo installed.
  const result = await session.exec(
    `if [ "$(id -u)" = 0 ]; then python3 -c ${quote(REMOTE_SUPERVISOR)}; else ${command}; fi`,
    30_000,
    { stdin: JSON.stringify({ operation, operationId, digest, steps }), outputLimitBytes: 1_048_576 },
  )
  if (result.code !== 0) throw new ServerError('job_recovering', { detail: result.stderr.slice(-500) })
  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch (cause) {
    throw new ServerError('recipe_protocol', {}, { cause })
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('state' in value) ||
    !['not-started', 'running', 'completed', 'failed', 'unknown'].includes(String(value.state)) ||
    !('steps' in value) ||
    !Array.isArray(value.steps)
  )
    throw new ServerError('recipe_protocol')
  for (const step of value.steps)
    if (
      !step ||
      typeof step !== 'object' ||
      !Number.isInteger(step.ordinal) ||
      typeof step.software !== 'string' ||
      typeof step.state !== 'string' ||
      !Array.isArray(step.changes)
    )
      throw new ServerError('recipe_protocol')
  return value as RemoteResult
}
