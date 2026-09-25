'use strict';
const fs=require('node:fs');
const crypto=require('node:crypto');
const {Client}=require('ssh2');
const {WebSocketServer,WebSocket}=require('ws');
const {sameOrigin,sessionToken,ticketStore,limiter}=require('./security');
module.exports=function attachSSH({server,config,send,readBody,verifyPassword,sessionValid,ClientClass=Client}){
 const tickets=ticketStore(),attempts=limiter({max:5}),connections=new Map();
 const wss=new WebSocketServer({noServer:true,maxPayload:32768,perMessageDeflate:false});
 function settings(){const s=config.ssh;if(!s?.enabled||!s.username||!s.privateKey||!s.hostPublicKey||!Number.isInteger(s.port)||s.port<1||s.port>65535)throw Error('Web SSH 尚未配置，请运行安装程序配置本机 SSH');return s}
 function available(){try{const s=settings();fs.accessSync(s.privateKey,fs.constants.R_OK);fs.accessSync(s.hostPublicKey,fs.constants.R_OK);return {ok:true,enabled:true,username:s.username,host:'127.0.0.1',port:s.port}}catch(e){return {ok:true,enabled:false,msg:e.message}}}
 async function route(req,res,url){if(!url.pathname.startsWith('/api/ssh/'))return false;
  if(req.method==='GET'&&url.pathname==='/api/ssh/status'){send(res,200,available());return true}
  if(req.method==='POST'&&url.pathname==='/api/ssh/ticket'){
   const token=sessionToken(req);if(!sessionValid(token)){send(res,401,{ok:false,msg:'请先登录'});return true}
   if(!attempts.check(req.socket.remoteAddress||'local')){send(res,429,{ok:false,msg:'SSH 验证尝试过多，请 15 分钟后重试'});return true}
   try{const b=JSON.parse(await readBody(req));if(typeof b.password!=='string'||b.password.length>1024||!verifyPassword(b.password)){send(res,401,{ok:false,msg:'面板密码错误'});return true}const status=available();if(!status.enabled)throw Error(status.msg);send(res,200,{ok:true,ticket:tickets.issue(token)});}catch(e){send(res,400,{ok:false,msg:e.message})}return true;
  }send(res,404,{ok:false,msg:'SSH 接口不存在'});return true;
 }
 function revoke(token){tickets.revoke(token);for(const [ws,c]of connections)if(c.token===token){c.ssh.end();ws.close(1008,'会话已退出')}}
 server.on('upgrade',(req,socket,head)=>{
  socket.on('error',()=>{});
  const reject=()=>{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')};
  let url;try{url=new URL(req.url,'http://localhost')}catch{return reject()}
  const token=sessionToken(req);
  if(url.pathname!=='/api/ssh/socket'||!sameOrigin(req)||!sessionValid(token)||connections.size>=8||[...connections.values()].filter(c=>c.token===token).length>=2||!tickets.consume(url.searchParams.get('ticket'),token))return reject();
  let s,key,hostKey;try{s=settings();key=fs.readFileSync(s.privateKey);hostKey=Buffer.from(fs.readFileSync(s.hostPublicKey,'utf8').trim().split(/\s+/)[1],'base64');if(!hostKey.length)throw Error()}catch{return reject()}
  wss.handleUpgrade(req,socket,head,ws=>{
   const ssh=new ClientClass();const state={token,ssh,channel:null,lastInput:Date.now(),started:Date.now(),alive:true};connections.set(ws,state);
   const output=(type,data)=>{if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>1024*1024){ws.close(1009,'终端输出过快');ssh.end();return}ws.send(JSON.stringify({type,data}))};
   const cleanup=()=>{connections.delete(ws);clearTimeout(connectTimer);ssh.end()};ws.on('close',cleanup);ws.on('error',cleanup);ws.on('pong',()=>state.alive=true);
   const connectTimer=setTimeout(()=>{output('error','SSH 连接超时');ws.close();ssh.end()},20000);
   ssh.on('error',()=>{output('error','SSH 连接失败，请检查本机 SSH 服务、账户和密钥配置');ws.close()});ssh.on('close',()=>{output('closed','SSH 已断开');ws.close()});
   ssh.on('ready',()=>ssh.shell({term:'xterm-256color',cols:100,rows:30},(err,channel)=>{if(err){output('error','无法创建 SSH 终端');ws.close();return}clearTimeout(connectTimer);if(ws.readyState!==WebSocket.OPEN){channel.close();return}state.channel=channel;output('ready','已连接');channel.on('data',data=>output('data',data.toString('base64')));channel.stderr.on('data',data=>output('data',data.toString('base64')));channel.on('error',()=>ws.close());channel.on('close',()=>ws.close());}));
   ws.on('message',(raw,binary)=>{if(!sessionValid(token)){ws.close(1008,'登录已过期');return}let b;try{if(binary)throw Error();b=JSON.parse(raw.toString());if(b.type==='input'&&typeof b.data==='string'&&b.data.length<=8192){state.lastInput=Date.now();if(state.channel){if(state.channel.writableLength>65536)throw Error();state.channel.write(b.data)}}else if(b.type==='resize'&&Number.isInteger(b.rows)&&Number.isInteger(b.cols)&&b.rows>=2&&b.rows<=300&&b.cols>=2&&b.cols<=500){state.channel?.setWindow(b.rows,b.cols,0,0)}else throw Error()}catch{ws.close(1008,'无效终端消息')}});
   ssh.connect({host:'127.0.0.1',port:s.port,username:s.username,privateKey:key,hostVerifier:remote=>remote.length===hostKey.length&&crypto.timingSafeEqual(remote,hostKey),readyTimeout:15000,keepaliveInterval:10000,keepaliveCountMax:3});
  });
 });
 const heartbeat=setInterval(()=>{const now=Date.now();for(const [ws,c]of connections){if(!sessionValid(c.token)||now-c.lastInput>15*60*1000||now-c.started>2*60*60*1000||!c.alive){c.ssh.end();ws.close(1008,'会话到期或连接中断');setTimeout(()=>ws.terminate(),1000).unref();continue}c.alive=false;ws.ping()}},30000);heartbeat.unref();
 server.on('close',()=>{clearInterval(heartbeat);for(const [ws,c]of connections){c.ssh.end();ws.terminate()}wss.close()});
 return {route,revoke};
};
