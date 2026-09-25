'use strict';
const fs=require('node:fs'),path=require('node:path');
function binary(command){const name=path.basename(command);for(const dir of ['/usr/sbin','/usr/bin','/sbin','/bin','/usr/local/bin']){const file=path.join(dir,name);try{fs.accessSync(file,fs.constants.X_OK);return file}catch{}}return command}
function packageCommands(name){if(fs.existsSync('/usr/bin/apt-get'))return {update:[binary('apt-get'),['-o','APT::Update::Error-Mode=any','update']],install:[binary('apt-get'),['install','-y',name]]};if(fs.existsSync('/usr/bin/dnf'))return {update:[binary('dnf'),['makecache','--refresh']],install:[binary('dnf'),['install','-y',name]]};if(fs.existsSync('/usr/bin/pacman'))return {update:[binary('pacman'),['-Sy','--noconfirm']],install:[binary('pacman'),['-S','--needed','--noconfirm',name]]};throw Error('暂不支持此系统的包管理器，请通过 SSH 安装所需软件')}
module.exports={binary,packageCommands};
