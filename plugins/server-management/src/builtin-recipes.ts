import type { LoadedScript } from './recipe.ts'
import { quote } from './recipe.ts'

/** Uses only already configured apt sources. Repository setup is a separate, explicitly authorized change. */
export const APT_RECIPE = String.raw`
import sys,json,subprocess,re,hashlib,tempfile,os
r=json.load(sys.stdin)
op=r['operation']
software=r['software']
names=['docker-ce','docker.io'] if software=='builtin/docker-engine' else ['docker-compose-plugin','docker-compose-v2']
def run(args):
 p=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=dict(__import__('os').environ,LC_ALL='C',DEBIAN_FRONTEND='noninteractive'))
 if p.returncode: raise RuntimeError(p.stderr[-500:])
 return p.stdout
def docker_read(args):
 try:return run(['docker']+args)
 except RuntimeError as ordinary:
  if os.geteuid()==0:raise
  try:return run(['sudo','-n','docker']+args)
  except (OSError,RuntimeError):raise ordinary
def product(v):
 m=re.match(r'(?:\d+:)?(\d+\.\d+\.\d+)',v)
 if not m: raise RuntimeError('Unsupported product version: '+v)
 return m.group(1)
def matches_package(reported,version):
 # Distributions may compile their complete package version into the binary.
 # Accept only the installed package, its upstream part, or its product version.
 packaged=version.split(':',1)[-1]
 upstream=packaged.rsplit('-',1)[0]
 return reported in (product(version),packaged,upstream)
def installed(name):
 p=subprocess.run(['dpkg-query','-W','-f='+'$'+'{Status}\t'+'$'+'{Version}\t'+'$'+'{Architecture}',name],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode or not p.stdout.startswith('install ok installed\t'): return None
 return p.stdout.strip().split('\t')[1:]
def package(name,version):
 blocks=run(['apt-cache','show',name+'='+version]).strip().split('\n\n')
 for block in blocks:
  fields=dict(line.split(': ',1) for line in block.splitlines() if ': ' in line and not line.startswith(' '))
  if fields.get('Version')==version and fields.get('SHA256') and fields.get('Filename'):
   return dict(manager='apt',name=name,version=version,architecture=fields['Architecture'],source=fields['Filename'],checksum=fields['SHA256'])
 raise RuntimeError('Exact package metadata unavailable: '+name+'='+version)
def candidates():
 for name in names:
  rows=run(['apt-cache','madison',name]).splitlines()
  found=[]
  for row in rows:
   fields=row.split('|')
   if len(fields)<3: continue
   version=fields[1].strip()
   try: p=package(name,version); v=product(version)
   except RuntimeError: continue
   found.append(dict(version=v,targetIdentity=name+'='+version,packages=[p],channel='stable'))
  if found: return found
 return []
def detect():
 for name in names:
  found=installed(name)
  if found:
   version,arch=found
   if software=='builtin/docker-engine': reported=docker_read(['version','--format','{{.Server.Version}}']).strip().lstrip('v')
   else: reported=docker_read(['compose','version','--short']).strip().lstrip('v')
   if not matches_package(reported,version):raise RuntimeError('Running software differs from the installed package')
   return dict(state='installed',version=product(version),targetIdentity=name+'='+version,packages=[dict(manager='apt',name=name,version=version,architecture=arch,source='installed')],healthy=True)
 # Refuse to overwrite an unmanaged Docker/Compose installation.
 p=subprocess.run(['sh','-c','command -v docker'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode==0:
  if software=='builtin/docker-engine': return dict(state='unknown',code='unmanaged_installation')
  p=subprocess.run(['docker','compose','version'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  if p.returncode==0: return dict(state='unknown',code='unmanaged_installation')
 return dict(state='missing')
def resolve(target,action="install"):
 root=target['packages'][0]
 output=run(['apt-get','--simulate','--no-install-recommends','--no-remove','install',root['name']+'='+root['version']])
 if any(line.startswith('Remv ') for line in output.splitlines()): raise RuntimeError('Package removal requires confirmation')
 result=[]
 for line in output.splitlines():
  if not line.startswith('Inst '): continue
  match=re.match(r'Inst (\S+)(?: \[([^]]+)\])? \((\S+)',line)
  if not match: raise RuntimeError('Unrecognized dependency resolution')
  name,previous,version=match.groups()
  if previous and action=='install': raise RuntimeError('Changing an installed dependency requires confirmation: '+name)
  result.append(package(name,version))
 for line in output.splitlines():
  if line.startswith('Conf ') and line.split()[1] not in [p['name'] for p in result]: raise RuntimeError('Configuring an existing package requires confirmation')
 if not any(p['name']==root['name'] and p['version']==root['version'] for p in result): raise RuntimeError('Target changed during preflight')
 return result
def guarded_install(expected,current,action):
 hook="""import sys,json,subprocess,hashlib
expected=json.load(open(sys.argv[1]))
allowed={(p['name'],p['version'],p['architecture']):p['checksum'] for p in expected}
for path in sys.stdin.read().splitlines():
 fields=subprocess.check_output(['dpkg-deb','--show','--showformat='+'$'+'{Package}\t'+'$'+'{Version}\t'+'$'+'{Architecture}',path],text=True).strip().split('\t')
 checksum=allowed.get(tuple(fields))
 if not checksum:sys.exit('Unplanned package: '+path)
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for block in iter(lambda:f.read(1048576),b''):h.update(block)
 if h.hexdigest()!=checksum:sys.exit('Package checksum changed: '+path)
"""
 with tempfile.TemporaryDirectory(prefix='smp-apt-') as directory:
  hookpath=directory+'/verify.py';planpath=directory+'/packages.json'
  with open(hookpath,'w') as f:f.write(hook)
  with open(planpath,'w') as f:json.dump(expected,f)
  run(['apt-get','--yes','--no-install-recommends','--no-remove','-o','APT::Get::AllowUnauthenticated=false','-o','DPkg::Pre-Install-Pkgs::=python3 '+hookpath+' '+planpath,'install']+(['--allow-downgrades'] if action=='replace' else [])+[p['name']+'='+p['version'] for p in current])
try:
 if op=='detect': result=dict(operation=op,result=detect())
 elif op=='list-candidates': result=dict(operation=op,candidates=candidates())
 elif op=='resolve':
  action=r.get('action','install');packages=resolve(r['target'],action)
  result=dict(operation=op,change=dict(software=software,recipe=r['recipe'],recipeRevision=r['recipeRevision'],action=action,before=r['installed'],target=r['target'],dependencies=[],effects=[dict(kind='service-restart',description=dict(zh='软件变更可能重启服务或中断容器，请安排维护时间。',en='Software changes may restart services or interrupt containers. Schedule a maintenance window.'))],payload=dict(packages=packages)),additionalRequirements=[])
 elif op=='execute':
  change=r['change']; expected=change['payload']['packages']; root=change['target']['packages'][0]
  actual=detect()
  if actual['state']=='installed' and actual['targetIdentity']==change['target']['targetIdentity']:
   result=dict(operation=op,state='completed',changes=[])
  else:
   if actual!=change['before']: raise RuntimeError('Software changed after preflight')
   current=resolve(change['target'],change['action'])
   allowed={p['name']:p for p in expected}
   if any(allowed.get(p['name'])!=p for p in current): raise RuntimeError('Dependency plan changed')
   for p in expected:
    if not any(q['name']==p['name'] for q in current):
     found=installed(p['name'])
     if not found or found[0]!=p['version']: raise RuntimeError('Dependency changed')
   guarded_install(expected,current,change['action'])
   result=dict(operation=op,state='completed',changes=expected)
 elif op=='verify':
  actual=detect(); ok=actual['state']=='installed' and actual['targetIdentity']==r['change']['target']['targetIdentity']
  for p in r['change']['payload']['packages']:
   found=installed(p['name'])
   if not found or found[0]!=p['version']:ok=False
  result=dict(operation=op,result=actual,healthy=ok)
 elif op=='recover': result=dict(operation=op,state='unknown',changes=[],code='use_host_operation_record')
 else: raise RuntimeError('Unknown operation')
 print(json.dumps(result))
except Exception as e:
 if op=='detect': print(json.dumps(dict(operation=op,result=dict(state='unknown',code='detection_failed',detail=str(e)[-500:]))))
 elif op=='execute':
  changed=[p for p in r['change']['payload']['packages'] if installed(p['name']) and installed(p['name'])[0]==p['version']]
  print(json.dumps(dict(operation=op,state='failed',changes=changed,code='installation_failed',detail=str(e)[-500:])))
 else: print(str(e)[-500:],file=sys.stderr);sys.exit(1)
`
export function aptScript(): LoadedScript {
  return Object.freeze({
    interpreter: 'posix-sh',
    body: `exec python3 -c ${quote(APT_RECIPE)}`,
    timeoutMs: 600_000,
    outputLimitBytes: 1_048_576,
  })
}
