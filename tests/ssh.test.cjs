const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {Server}=require('ssh2'),{WebSocket}=require('ws');
const attach=require('../ssh');
test('authenticated WebSocket uses pinned SSH host, supports terminal IO and logout cleanup',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'taropanel-ssh-'));
 execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(dir,'host')]);
 execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(dir,'client')]);
 const sshServer=new Server({hostKeys:[fs.readFileSync(path.join(dir,'host'))]},client=>{client.on('error',()=>{});client.on('authentication',ctx=>{if(ctx.method==='publickey'&&ctx.username==='test-user')ctx.accept();else ctx.reject()});client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('pty',(accept)=>accept());session.on('window-change',accept=>accept?.());session.on('shell',accept=>{const stream=accept();stream.write('fixture-ready\r\n');stream.on('data',data=>stream.write(data))})}))});
 await new Promise(r=>sshServer.listen(0,'127.0.0.1',r));
 const token='a'.repeat(64),valid=new Set([token]);let handler;
 const server=http.createServer(async(req,res)=>{await handler.route(req,res,new URL(req.url,'http://localhost'))});
 const config={ssh:{enabled:true,username:'test-user',port:sshServer.address().port,privateKey:path.join(dir,'client'),hostPublicKey:path.join(dir,'host.pub')}};
 handler=attach({server,config,send:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))},readBody:async req=>{let s='';for await(const b of req)s+=b;return s},verifyPassword:p=>p==='test-password-only',sessionValid:token=>valid.has(token)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{handler.revoke(token);server.closeAllConnections();server.close();sshServer.close();fs.rmSync(dir,{recursive:true,force:true})});
 const base='http://127.0.0.1:'+server.address().port,origin=base;
 async function ticket(password='test-password-only'){return fetch(base+'/api/ssh/ticket',{method:'POST',headers:{cookie:'panel_session='+token,'Content-Type':'application/json'},body:JSON.stringify({password})})}
 assert.equal((await ticket('wrong')).status,401);
 const minted=await(await ticket()).json();assert(minted.ticket);
 const url=base.replace('http','ws')+'/api/ssh/socket?ticket='+minted.ticket;
 const ws=new WebSocket(url,{headers:{Origin:origin,Cookie:'panel_session='+token}});
 const messages=[];ws.on('message',data=>messages.push(JSON.parse(data.toString())));
 await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(Error('SSH ready timed out')),10000);const poll=setInterval(()=>{if(messages.some(m=>m.type==='ready')){clearTimeout(deadline);clearInterval(poll);resolve()}},10);ws.on('error',reject)});
 ws.send(JSON.stringify({type:'input',data:'terminal-echo\n'}));
 await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(Error('echo timeout')),5000);const poll=setInterval(()=>{if(messages.some(m=>m.type==='data'&&Buffer.from(m.data,'base64').toString().includes('terminal-echo'))){clearTimeout(deadline);clearInterval(poll);resolve()}},10)});
 ws.send(JSON.stringify({type:'resize',rows:40,cols:120}));
 async function rejected(url,headers){return new Promise((resolve,reject)=>{const socket=new WebSocket(url,{headers});socket.on('unexpected-response',(req,res)=>{assert.equal(res.statusCode,403);res.resume();socket.terminate();resolve()});socket.on('error',()=>{});socket.on('open',()=>{socket.terminate();reject(Error('unauthorized upgrade accepted'))})})}
 await rejected(url,{Origin:origin,Cookie:'panel_session='+token});
 const another=await(await ticket()).json();await rejected(base.replace('http','ws')+'/api/ssh/socket?ticket='+another.ticket,{Origin:'https://evil.test',Cookie:'panel_session='+token});
 const closed=new Promise(r=>ws.once('close',r));handler.revoke(token);await closed;
 // A wrong pinned key must fail before a shell is opened.
 config.ssh.hostPublicKey=path.join(dir,'client.pub');const bad=await(await ticket()).json();const badSocket=new WebSocket(base.replace('http','ws')+'/api/ssh/socket?ticket='+bad.ticket,{headers:{Origin:origin,Cookie:'panel_session='+token}});let ready=false;badSocket.on('message',data=>{if(JSON.parse(data).type==='ready')ready=true});await new Promise(r=>badSocket.once('close',r));assert.equal(ready,false);
});
