const {test}=require('node:test'),assert=require('node:assert/strict');
const {limiter,sameOrigin,sessionToken,ticketStore}=require('../security');
test('password attempts are bounded and per-peer',()=>{const l=limiter({max:2});assert(l.check('a'));assert(l.check('a'));assert(!l.check('a'));assert(l.check('b'));l.clear('a');assert(l.check('a'))});
test('origin must exactly match the browser host',()=>{assert(sameOrigin({headers:{host:'panel.test:80',origin:'http://panel.test:80'}}));assert(!sameOrigin({headers:{host:'panel.test',origin:'https://evil.test'}}));assert(!sameOrigin({headers:{host:'panel.test'}}))});
test('ticket is single-use and bound to its owner',()=>{const store=ticketStore(),t=store.issue('a');assert(!store.consume(t,'b'));assert(!store.consume(t,'a'));const next=store.issue('a');assert(store.consume(next,'a'));assert(!store.consume(next,'a'));const revoked=store.issue('a');store.revoke('a');assert(!store.consume(revoked,'a'))});
test('cookie parsing rejects ambiguous short tokens',()=>{const t='a'.repeat(64);assert.equal(sessionToken({headers:{cookie:'x=1; panel_session='+t}}),t);assert.equal(sessionToken({headers:{cookie:'not_panel_session='+t}}),undefined)});
