'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),http=require('http');
const {spawn}=require('child_process');
const {binary,packageCommands}=require('./platform');
module.exports=function createOperations({root,send,readBody,getProjects,invalidateProjects}) {
 const dataDir=path.join(root,'data');fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 const readJSON=(f,fallback)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return fallback}};
 function atomic(f,content,mode=0o600){const t=f+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';try{fs.writeFileSync(t,content,{mode});fs.renameSync(t,f)}finally{if(fs.existsSync(t))fs.unlinkSync(t)}}
 function run(cmd,args,{cwd,timeout=30000,onData}={}){return new Promise((resolve,reject)=>{
   const child=spawn(binary(cmd),args,{cwd,env:{...process.env,LC_ALL:'C.UTF-8',DEBIAN_FRONTEND:'noninteractive'},stdio:['ignore','pipe','pipe']});let out='',err='',timedOut=false;
   const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},timeout);
   child.stdout.on('data',c=>{out=(out+c).slice(-2000000);onData?.(String(c))});child.stderr.on('data',c=>{err=(err+c).slice(-200000);onData?.(String(c))});
   child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('close',code=>{clearTimeout(timer);if(code!==0||timedOut)reject(Error(timedOut?'操作超时，进程已终止，请检查实际状态':(err||out||'命令执行失败').slice(-6000)));else resolve(out.trim())});
 })}
 const jobs=new Map(),locks=new Set();
 function job(kind,label,fn){if(locks.has(kind)){const e=Error('同类任务正在执行，请等待完成');e.status=409;throw e}locks.add(kind);const id=crypto.randomUUID(),j={id,label,state:'running',startedAt:Date.now(),log:''};jobs.set(id,j);while(jobs.size>40){const old=[...jobs.values()].find(x=>x.state!=='running');if(!old)break;jobs.delete(old.id)}
  Promise.resolve().then(()=>fn(t=>{j.log=(j.log+t).slice(-20000)})).then(result=>{j.state='done';j.result=result||'完成'}).catch(e=>{j.state='failed';j.error=e.message}).finally(()=>{j.finishedAt=Date.now();locks.delete(kind);invalidateProjects()});return {ok:true,job:id};}
 async function composeProjects(){
  const all=JSON.parse(await run('/usr/bin/docker',['compose','ls','--all','--format','json']));
  const known=readJSON(path.join(dataDir,'compose-projects.json'),[]);
  const map=new Map(known.map(p=>[p.name,p]));
  for(const p of all){const files=p.ConfigFiles.split(',').filter(Boolean);if(files.length&&files.every(f=>path.isAbsolute(f)))map.set(p.Name,{name:p.Name,files,dir:path.dirname(files[0]),status:p.Status})}
  // Docker records the exact working directory, which can differ from the first file's directory.
  const ids=(await run('/usr/bin/docker',['ps','-aq'])).split('\n').filter(Boolean);
  if(ids.length){const labels=(await run('/usr/bin/docker',['inspect','--format','{{json .Config.Labels}}',...ids])).split('\n');for(const line of labels){const l=JSON.parse(line)||{},p=map.get(l['com.docker.compose.project']);if(p&&path.isAbsolute(l['com.docker.compose.project.working_dir']||''))p.dir=l['com.docker.compose.project.working_dir']}}
  return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
 }
 async function project(name){const p=(await composeProjects()).find(p=>p.name===name);if(!p)throw Error('Compose 项目不存在');return p}
 function composeArgs(p,files=p.files){return ['compose','--project-directory',p.dir,'--project-name',p.name,...files.flatMap(f=>['-f',f])]}
 function fileData(p,index){const f=p.files[index];if(!f)throw Error('文件不存在');const st=fs.lstatSync(f);if(!st.isFile()||st.isSymbolicLink()||st.size>500000)throw Error('仅支持编辑小于 500KB 的普通 Compose 文件');const content=fs.readFileSync(f,'utf8');return {file:f,content,revision:hash(content)}}
 async function validateCompose(p,index,content){if(typeof content!=='string'||Buffer.byteLength(content)>500000||!content.trim())throw Error('Compose 内容不能为空，且不能超过 500KB');
  const temp=path.join(path.dirname(p.files[index]),'.panel-validate-'+crypto.randomBytes(8).toString('hex')+'.yaml');
  try{fs.writeFileSync(temp,content,{mode:0o600,flag:'wx'});const files=[...p.files];files[index]=temp;await run('/usr/bin/docker',[...composeArgs(p,files),'config','--quiet'],{cwd:p.dir})}finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}
 }
 const firewallPath=path.join(dataDir,'firewall.json'),nftPath=path.join(dataDir,'firewall.nft');
 const table='service_panel';
 function nftProgram(rules){let out=`add table inet ${table}\nflush table inet ${table}\nadd chain inet ${table} ingress { type filter hook prerouting priority -110; policy accept; }\n`;
  out+=`add rule inet ${table} ingress iifname "lo" accept\n`;
  for(const r of rules.filter(r=>r.action==='deny'))for(const protocol of r.protocol==='both'?['tcp','udp']:[r.protocol])out+=`add rule inet ${table} ingress fib daddr type local meta l4proto ${protocol} ${protocol} dport ${r.port.replace(':','-')} counter drop comment "panel-${r.id}"\n`;
  return out;
 }
 async function protectedPorts(){const out=await run('/usr/bin/ss',['-ltnpH']);const ports=new Set([22,Number(process.env.PANEL_PORT||80)]);for(const line of out.split('\n'))if(/sshd|sshd-session/.test(line)){const m=line.trim().split(/\s+/)[3]?.match(/:(\d+)$/);if(m)ports.add(+m[1])}return [...ports]}
 function validateRule(b,protectedList){if(!['tcp','udp','both'].includes(b.protocol)||!['allow','deny'].includes(b.action)||!/^\d{1,5}(?::\d{1,5})?$/.test(String(b.port)))throw Error('规则参数无效');const [start,end=start]=String(b.port).split(':').map(Number);if(start<1||end>65535||end<start)throw Error('端口范围必须为 1–65535');if(b.action==='deny'&&b.protocol!=='udp'&&protectedList.some(p=>p>=start&&p<=end))throw Error('不能屏蔽面板或 SSH 管理端口');return {port:start===end?String(start):`${start}:${end}`,protocol:b.protocol,action:b.action}}
 function matchesPort(rule,port,protocol){const [lo,hi=lo]=String(rule.port).split(':').map(Number);return port>=lo&&port<=hi&&(rule.protocol==='both'||rule.protocol===protocol)}
 function allowScanned(rules,ports){
  for(const item of ports){const port=Number(item.port),protocol=item.protocol;
   rules=rules.flatMap(r=>{if(!matchesPort(r,port,protocol))return [r];const [lo,hi=lo]=r.port.split(':').map(Number),parts=[];
    const part=(a,b,p)=>({...r,id:crypto.randomBytes(8).toString('hex'),port:a===b?String(a):`${a}:${b}`,protocol:p});
    if(r.protocol==='both')parts.push(part(lo,hi,protocol==='tcp'?'udp':'tcp'));
    if(lo<port)parts.push(part(lo,port-1,protocol));if(hi>port)parts.push(part(port+1,hi,protocol));return parts;
   });
   rules.push({id:crypto.randomBytes(8).toString('hex'),port:String(port),protocol,action:'allow',note:item.services.join('；')||'未识别服务',updatedAt:Date.now()});
  }return rules;
 }
 async function scanPorts(){
  const warnings=[],rows=new Map();let containers=[];
  const results=await Promise.allSettled([run('/usr/bin/ss',['-H','-lntup']), (async()=>{const ids=(await run('/usr/bin/docker',['ps','-q'])).split('\n').filter(Boolean);return ids.length?JSON.parse(await run('/usr/bin/docker',['inspect',...ids])):[]})()]);
  if(results[0].status==='rejected')throw Error('监听端口扫描失败：'+results[0].reason.message);
  if(results[1].status==='fulfilled')containers=results[1].value;else warnings.push('Docker 端口读取失败：'+results[1].reason.message);
  function add(port,protocol,address,services){if(!['tcp','udp'].includes(protocol)||!Number.isInteger(port)||port<1||port>65535)return;const key=protocol+':'+port;let r=rows.get(key);if(!r){r={port:String(port),protocol,addresses:new Set(),services:new Set()};rows.set(key,r)}r.addresses.add(address);services.forEach(n=>r.services.add(n))}
  const pidServices=new Map();
  function owner(pid){if(pidServices.has(pid))return pidServices.get(pid);let names=[];try{const cg=fs.readFileSync('/proc/'+pid+'/cgroup','utf8');const c=containers.find(c=>cg.includes(c.Id));if(c)names=['Docker · '+c.Name.replace(/^\//,'')];else names=[...new Set([...cg.matchAll(/(?:^|\/)([^/\n]+\.service)(?=\/|$)/gm)].map(m=>'系统服务 · '+m[1]))]}catch{}pidServices.set(pid,names);return names}
  for(const line of results[0].value.split('\n')){const a=line.trim().split(/\s+/);if(!['tcp','udp'].includes(a[0]))continue;const m=a[4]?.match(/^(.*):(\d+)$/);if(!m)continue;const services=[...line.matchAll(/pid=(\d+)/g)].flatMap(m=>owner(m[1]));if(!services.length)services.push(...[...line.matchAll(/\("([^"\n]+)"/g)].map(m=>'进程 · '+m[1]));add(+m[2],a[0],m[1].replace(/^\[|\]$/g,''),services)}
  for(const c of containers)for(const [target,bindings]of Object.entries(c.NetworkSettings?.Ports||{})){const protocol=target.split('/')[1];for(const b of bindings||[])add(+b.HostPort,protocol,b.HostIp||'0.0.0.0',['Docker · '+c.Name.replace(/^\//,'')+' → '+target])}
  const rules=readJSON(firewallPath,[]);
  const ports=[...rows.values()].map(r=>{const addresses=[...r.addresses],localOnly=addresses.every(a=>a==='::1'||/^127\./.test(a)||/^::ffff:127\./i.test(a)),services=[...r.services].filter(n=>!([...r.services].some(v=>v.startsWith('Docker · '))&&(n==='系统服务 · docker.service'||n==='进程 · docker-proxy')));return {...r,addresses,services,localOnly,state:rules.some(x=>x.action==='deny'&&matchesPort(x,+r.port,r.protocol))?'deny':rules.some(x=>x.action==='allow'&&matchesPort(x,+r.port,r.protocol))?'allow':'default'}}).sort((a,b)=>+a.port-+b.port||a.protocol.localeCompare(b.protocol));
  return {ok:true,ports,warnings,scannedAt:Date.now()};
 }
 async function firewallStatus(){const installed=fs.existsSync(binary('/usr/sbin/nft'));let active=false,error='';if(installed)try{await run('/usr/sbin/nft',['list','table','inet',table]);active=true}catch(e){if(!/No such file/.test(e.message))error=e.message}
  return {ok:true,installed,active,error,rules:readJSON(firewallPath,[]),protectedPorts:await protectedPorts(),note:'当前采用默认放行模式：没有屏蔽规则的端口，本面板不拦截。记录放行会解除所选端口在本面板中的屏蔽，并保存关联服务备注；不会改变其他端口的默认策略。实际外部可达性还取决于监听地址、其他防火墙和云安全组。'};
 }
 async function applyFirewall(rules){const file=path.join(dataDir,'firewall-check.nft');atomic(file,nftProgram(rules));await run('/usr/sbin/nft',['--check','--file',file]);await run('/usr/sbin/nft',['--file',file]);atomic(nftPath,nftProgram(rules));atomic(firewallPath,JSON.stringify(rules));}
 // Persist only observed deltas; unknown/unsupported counters are never shown as zero.
 const trafficPath=path.join(dataDir,'traffic.json');let traffic=readJSON(trafficPath,{since:Date.now(),entities:{}}),sampling=false,lastSample=null,trafficError='';
 const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),enabledUnits=new Map();
 function record(id,label,kind,identity,rx,tx,available=true,note=''){
  const now=Date.now(),e=traffic.entities[id]||={label,kind,totalRx:0,totalTx:0,buckets:{},firstSeen:now};e.label=label;e.available=available;e.note=note;e.lastSeen=now;e.rxRate=null;e.txRate=null;
  if(!available){delete e.previous;return}const prev=e.previous;let dr=0,dt=0;
  if(prev&&prev.identity===identity&&rx>=prev.rx&&tx>=prev.tx){dr=rx-prev.rx;dt=tx-prev.tx;const seconds=(now-prev.time)/1000;if(seconds>0&&seconds<180){e.rxRate=dr/seconds;e.txRate=dt/seconds}}
  const bucket=String(Math.floor(now/300000)*300000);const b=e.buckets[bucket]||=[0,0];b[0]+=dr;b[1]+=dt;e.totalRx+=dr;e.totalTx+=dt;e.previous={identity,rx,tx,time:now};e.counterRx=rx;e.counterTx=tx;
  for(const key of Object.keys(e.buckets))if(+key<now-31*86400000)delete e.buckets[key];
 }
 function dockerStats(id){return new Promise((resolve,reject)=>{const req=http.get({socketPath:'/var/run/docker.sock',path:'/containers/'+id+'/stats?stream=false&one-shot=true',timeout:12000},res=>{let data='';res.on('data',c=>{data+=c;if(data.length>2000000)req.destroy(Error('统计数据过大'))});res.on('end',()=>{try{if(res.statusCode!==200)throw Error('容器统计不可用');resolve(JSON.parse(data))}catch(e){reject(e)}})});req.on('timeout',()=>req.destroy(Error('容器统计超时')));req.on('error',reject)})}
 async function sample(){if(sampling)return;sampling=true;const now=Date.now();try{
  const net=fs.readFileSync('/proc/net/dev','utf8');for(const line of net.split('\n')){const m=line.match(/^\s*([^:]+):\s*(.*)$/);if(!m||m[1]==='lo'||/^(veth|br-|docker)/.test(m[1]))continue;const a=m[2].trim().split(/\s+/).map(Number);record('nic:'+m[1],m[1],'nic',boot,a[0],a[8])}
  const projects=await getProjects();
  const unitNames=projects.systemd.map(s=>s.name);
  for(const name of unitNames)if(now-(enabledUnits.get(name)||0)>900000){try{await run('/usr/bin/systemctl',['set-property','--runtime',name,'IPAccounting=yes']);enabledUnits.set(name,now)}catch{enabledUnits.set(name,now)}}
  if(unitNames.length){const output=await run('/usr/bin/systemctl',['show',...unitNames,'--property=Id,InvocationID,IPIngressBytes,IPEgressBytes,IPAccounting']);for(const block of output.split(/\n\s*\n/)){const d=Object.fromEntries(block.split('\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));if(!d.Id)continue;const rx=Number(d.IPIngressBytes),tx=Number(d.IPEgressBytes),ok=d.IPAccounting==='yes'&&Number.isSafeInteger(rx)&&Number.isSafeInteger(tx);record('systemd:'+d.Id,d.Id,'systemd',boot+':'+d.InvocationID,rx,tx,ok,ok?'按 systemd IPAccounting 计量；既有连接可能需服务下次重启后完整计入':'当前内核或服务不提供流量计数')}}
  const ids=(await run('/usr/bin/docker',['ps','-aq'])).split('\n').filter(Boolean);
  if(ids.length){const rows=JSON.parse(await run('/usr/bin/docker',['inspect',...ids]));for(const c of rows){const name=c.Name.slice(1);if(!projects.docker.some(p=>p.name===name))continue;const id='docker:'+name;const supported=!['host','none'].includes(c.HostConfig.NetworkMode)&&!String(c.HostConfig.NetworkMode).startsWith('container:');if(!supported){record(id,name,'docker',c.Id,0,0,false,'共享主机/容器网络或无网络，无法独立归属');continue}if(!c.State.Running){const old=traffic.entities[id];record(id,name,'docker',c.Id+':'+c.State.StartedAt,old?.previous?.rx||0,old?.previous?.tx||0,true,'容器未运行');continue}try{const d=await dockerStats(c.Id),nets=Object.values(d.networks||{});record(id,name,'docker',c.Id+':'+c.State.StartedAt,nets.reduce((s,n)=>s+n.rx_bytes,0),nets.reduce((s,n)=>s+n.tx_bytes,0),nets.length>0,nets.length?'按容器网络命名空间计量':'暂无独立网络计数')}catch(e){record(id,name,'docker',c.Id,0,0,false,e.message)}}}
  lastSample=Date.now();trafficError='';atomic(trafficPath,JSON.stringify(traffic));
 }catch(e){trafficError=e.message}finally{try{atomic(trafficPath,JSON.stringify(traffic))}catch(e){trafficError='流量历史保存失败：'+e.message}sampling=false}}
 function trafficView(period){const periods={'24h':86400000,'7d':7*86400000,'30d':30*86400000,total:Infinity};if(!(period in periods))throw Error('统计周期无效');const from=Date.now()-periods[period];const entities=Object.entries(traffic.entities).map(([id,e])=>{let rx=e.totalRx,tx=e.totalTx;if(period!=='total'){rx=0;tx=0;for(const [time,b]of Object.entries(e.buckets))if(+time>=from){rx+=b[0];tx+=b[1]}}return {id,label:e.label,kind:e.kind,rx,tx,rxRate:e.rxRate,txRate:e.txRate,available:e.available,note:e.note,lastSeen:e.lastSeen,firstSeen:e.firstSeen,stale:Date.now()-e.lastSeen>180000}});const series={};for(const e of Object.values(traffic.entities).filter(e=>e.kind==='nic'))for(const [time,b]of Object.entries(e.buckets))if(+time>=Math.max(from,Date.now()-30*86400000)){const t=String(Math.floor(+time/3600000)*3600000);series[t]||=[0,0];series[t][0]+=b[0];series[t][1]+=b[1]}
 return {ok:true,since:traffic.since,lastSample,error:trafficError,period,entities,series:Object.entries(series).sort((a,b)=>a[0]-b[0]).map(([time,[rx,tx]])=>({time:+time,rx,tx})),note:'累计从启用采集开始；每 60 秒采样、按 5 分钟归档。不同层级流量有重复，不应相加；既有系统服务连接可能需要下次重启后完整计入。'};
 }
 let interval;
 function start(){sample();interval=setInterval(sample,60000);interval.unref()}
 async function route(req,res,url){const p=url.pathname;if(!p.startsWith('/api/compose')&&!p.startsWith('/api/firewall')&&!p.startsWith('/api/traffic')&&!p.startsWith('/api/maintenance')&&!p.startsWith('/api/jobs'))return false;
  try{
   if(req.method==='GET'){
    if(p==='/api/jobs'){send(res,200,{ok:true,jobs:[...jobs.values()].map(({log,...j})=>j).reverse()});return true}
    if(p.startsWith('/api/jobs/')){const j=jobs.get(p.slice(10));if(!j){send(res,404,{ok:false,msg:'任务记录不存在，可能面板已重启'});return true}send(res,200,{ok:true,...j});return true}
    if(p==='/api/compose'){send(res,200,{ok:true,projects:await composeProjects()});return true}
    if(p==='/api/compose/file'){const pr=await project(url.searchParams.get('project'));send(res,200,{ok:true,...fileData(pr,Number(url.searchParams.get('index')||0))});return true}
    if(p==='/api/firewall/scan'){send(res,200,await scanPorts());return true}
    if(p==='/api/firewall'){send(res,200,await firewallStatus());return true}
    if(p==='/api/traffic'){send(res,200,trafficView(url.searchParams.get('period')||'24h'));return true}
   }
   if(req.method!=='POST'){send(res,404,{ok:false,msg:'接口不存在'});return true}
   let b;try{b=JSON.parse(await readBody(req));if(!b||typeof b!=='object'||Array.isArray(b))throw Error()}catch{throw Error('无效请求')}
   if(p==='/api/maintenance/update-sources'){send(res,202,job('packages','刷新软件源索引',async log=>{await run(...packageCommands('nftables').update,{timeout:600000,onData:log});return '已刷新现有软件源索引，未升级软件或更换源地址'}));return true}
   if(p==='/api/firewall/install'){send(res,202,job('packages','安装 nftables',async log=>{if(fs.existsSync(binary('/usr/sbin/nft')))return 'nftables 已安装，无需重复安装';await run(...packageCommands('nftables').update,{timeout:600000,onData:log});const mask='/run/systemd/system/nftables.service';let maskedHere=false;
       try { if(!fs.existsSync(mask)&&!(()=>{try{return fs.lstatSync(mask).isSymbolicLink()}catch{return false}})()){await run('/usr/bin/systemctl',['mask','--runtime','nftables.service']);maskedHere=true}
         await run(...packageCommands('nftables').install,{timeout:600000,onData:log});
         await run('/usr/bin/systemctl',['disable','nftables.service']);
       } finally {if(maskedHere)await run('/usr/bin/systemctl',['unmask','--runtime','nftables.service'])}
       return 'nftables 已安装；未启动系统默认规则，面板规则将在应用后单独保存与恢复'}));return true}
   if(p==='/api/firewall/allow-scanned'){
    if(!Array.isArray(b.ports)||!b.ports.length||b.ports.length>200)throw Error('请选择 1–200 个扫描端口');
    if(locks.has('firewall')){const e=Error('防火墙正在更新');e.status=409;throw e}locks.add('firewall');
    try{const scan=await scanPorts(),selected=[],seen=new Set();for(const item of b.ports){if(!item||!['tcp','udp'].includes(item.protocol)||!/^\d{1,5}$/.test(String(item.port)))throw Error('端口参数无效');const key=item.protocol+':'+item.port;if(seen.has(key))continue;seen.add(key);const port=scan.ports.find(p=>p.port===String(item.port)&&p.protocol===item.protocol);if(!port)throw Error('端口监听状态已变化，请重新扫描');if(port.localOnly)throw Error('仅本机监听的端口无需对外放行');selected.push(port)}
     const rules=allowScanned(readJSON(firewallPath,[]),selected);if(rules.length>200)throw Error('放行后超过 200 条规则，请先整理已有规则');await applyFirewall(rules);send(res,200,{ok:true,msg:'已记录 '+selected.length+' 个端口的放行规则及关联服务备注'});
    }finally{locks.delete('firewall')}return true;
   }
   if(p==='/api/firewall/rule'||p==='/api/firewall/delete'){
    if(locks.has('firewall')){const e=Error('防火墙正在更新');e.status=409;throw e}locks.add('firewall');try{
     let rules=readJSON(firewallPath,[]);if(p.endsWith('/delete')){if(!rules.some(r=>r.id===b.id))throw Error('规则不存在');rules=rules.filter(r=>r.id!==b.id)}else{const rule=validateRule(b,await protectedPorts());const [lo,hi=lo]=rule.port.split(':').map(Number);rules=rules.filter(r=>{const [a,z=a]=r.port.split(':').map(Number);const overlap=Math.max(a,lo)<=Math.min(z,hi)&&(r.protocol==='both'||rule.protocol==='both'||r.protocol===rule.protocol);if(overlap&&(r.port!==rule.port||r.protocol!==rule.protocol))throw Error('与已有规则范围重叠，请先删除原规则');return !overlap});let note='';try{const scan=await scanPorts();note=[...new Set(scan.ports.filter(p=>matchesPort(rule,+p.port,p.protocol)).flatMap(p=>p.services))].join('；')}catch{}rules.push({...rule,id:crypto.randomBytes(8).toString('hex'),note:note||'未识别服务',updatedAt:Date.now()})}
     if(rules.length>200)throw Error('最多支持 200 条规则');await applyFirewall(rules);send(res,200,{ok:true,msg:'规则已应用并持久保存'});
    }finally{locks.delete('firewall')}return true;
   }
   if(p==='/api/compose/create'){
    if(typeof b.project!=='string'||!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(b.project))throw Error('项目名称须为 1–63 位小写字母、数字、短横线或下划线，并以字母或数字开头');
    if(locks.has('compose-create')){const e=Error('正在创建项目，请稍后重试');e.status=409;throw e}locks.add('compose-create');
    let dir,created=false,registered=false;
    try{
     if((await composeProjects()).some(pr=>pr.name===b.project)){const e=Error('项目名称已存在');e.status=409;throw e}
     const base=path.join(dataDir,'compose');fs.mkdirSync(base,{recursive:true,mode:0o700});dir=path.join(base,b.project);
     if(fs.existsSync(dir)){const e=Error('项目目录已存在，请更换名称');e.status=409;throw e}
     fs.mkdirSync(dir,{mode:0o700});created=true;const pr={name:b.project,dir,files:[path.join(dir,'compose.yaml')],status:'未部署'};
     await validateCompose(pr,0,b.content);atomic(pr.files[0],b.content);
     const registry=path.join(dataDir,'compose-projects.json'),known=readJSON(registry,[]);known.push(pr);atomic(registry,JSON.stringify(known));registered=true;
     send(res,201,{ok:true,project:pr.name,msg:'项目已创建，尚未部署'});
    }finally{if(created&&!registered){const file=path.join(dir,'compose.yaml');if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(dir)}locks.delete('compose-create')}
    return true;
   }
   if(['/api/compose/validate','/api/compose/save','/api/compose/deploy'].includes(p)){
    const pr=await project(b.project),lock='compose:'+pr.name;if(locks.has(lock)){const e=Error('项目正在执行操作');e.status=409;throw e}
    if(p.endsWith('/deploy')){if(b.confirm!==true)throw Error('请确认部署');send(res,202,job(lock,'部署 '+pr.name,async log=>{await run('/usr/bin/docker',[...composeArgs(pr),'config','--quiet'],{cwd:pr.dir});await run('/usr/bin/docker',[...composeArgs(pr),'up','-d'],{cwd:pr.dir,timeout:900000,onData:log});return 'Compose 已部署；请检查容器健康状态'}));return true}
    locks.add(lock);try{const index=Number(b.index),current=fileData(pr,index);if(b.revision!==current.revision){const e=Error('文件已被其他操作修改，请重新加载后再编辑');e.status=409;throw e}await validateCompose(pr,index,b.content);if(p.endsWith('/save')){if(fileData(pr,index).revision!==b.revision){const e=Error('校验期间文件发生变化，请重新加载');e.status=409;throw e}const backupDir=path.join(dataDir,'compose-backups');fs.mkdirSync(backupDir,{recursive:true,mode:0o700});const backup=path.join(backupDir,Date.now()+'-'+hash(current.file).slice(0,16)+'.yaml');fs.copyFileSync(current.file,backup);fs.chmodSync(backup,0o600);const st=fs.statSync(current.file);atomic(current.file,b.content,st.mode&0o777);fs.chownSync(current.file,st.uid,st.gid);send(res,200,{ok:true,revision:hash(b.content),msg:'校验通过，已备份并保存；尚未重新部署'})}else send(res,200,{ok:true,msg:'Compose 配置校验通过'});
    }finally{locks.delete(lock)}return true;
   }
   send(res,404,{ok:false,msg:'接口不存在'});return true;
  }catch(e){send(res,e.status||400,{ok:false,msg:e.message});return true}
 }
 return {route,start,nftProgram,validateRule,record,trafficView,run,scanPorts,allowScanned};
};
