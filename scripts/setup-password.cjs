#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.env.PANEL_STATE_DIR||path.join(__dirname,'..');
const password=fs.readFileSync(0,'utf8').replace(/\r?\n$/,'');
if(password.length<12||password.length>1024){console.error('密码长度必须为 12–1024 个字符');process.exit(1)}
fs.mkdirSync(root,{recursive:true,mode:0o700});
const file=path.join(root,'config.json');let config={};if(fs.existsSync(file))config=JSON.parse(fs.readFileSync(file,'utf8'));
config.salt=crypto.randomBytes(16).toString('hex');config.passwordHash=crypto.scryptSync(password,config.salt,64).toString('hex');
fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});fs.chmodSync(file,0o600);
fs.writeFileSync(path.join(root,'sessions.json'),'{}',{mode:0o600});fs.chmodSync(path.join(root,'sessions.json'),0o600);
console.log('密码已设置，旧登录已撤销；运行中的面板需重启才能生效。');
