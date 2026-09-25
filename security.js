'use strict';
const crypto=require('node:crypto');
function limiter({windowMs=15*60*1000,max=10,capacity=10000}={}){
 const entries=new Map();
 return {check(key){const now=Date.now();for(const [k,v] of entries)if(v.until<=now)entries.delete(k);let v=entries.get(key);if(!v){if(entries.size>=capacity)return false;v={count:0,until:now+windowMs};entries.set(key,v)}return ++v.count<=max},clear(key){entries.delete(key)}};
}
function sameOrigin(req){return [`http://${req.headers.host}`,`https://${req.headers.host}`].includes(req.headers.origin)}
function sessionToken(req){return (req.headers.cookie||'').match(/(?:^|;\s*)panel_session=([a-f0-9]{64})(?:;|$)/)?.[1]}
function ticketStore(){const tickets=new Map();return {
 issue(owner){for(const [id,t]of tickets)if(t.expires<Date.now()||t.owner===owner)tickets.delete(id);if(tickets.size>=1000)throw Error('连接请求过多，请稍后重试');const id=crypto.randomBytes(32).toString('hex');tickets.set(id,{owner,expires:Date.now()+30000});return id},
 consume(id,owner){const t=tickets.get(id);tickets.delete(id);return !!t&&t.owner===owner&&t.expires>=Date.now()},
 revoke(owner){for(const [id,t]of tickets)if(t.owner===owner)tickets.delete(id)}
}}
module.exports={limiter,sameOrigin,sessionToken,ticketStore};
