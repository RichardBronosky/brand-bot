// Real Chromium UI regression test; Supabase HTTP responses are mocked.
// Requires Node 22+, chromium and zbarimg. No npm dependencies.
import assert from 'node:assert/strict';
import { createMockBackend } from './mock-backend.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync('/tmp/brand-browser-test-');
mkdirSync(join(root, 'vendor'));
for (const f of ['categories.mjs', 'build.mjs','template.html','sw.js','app.js','app.css','vendor/qrcodegen.js','qr.svg']) copyFileSync(join(source,f),join(root,f));
execFileSync(process.execPath,[join(root,'build.mjs')],{env:{...process.env,BRAND_CONFIG:JSON.stringify({
 name:'Meeting Test',domain:'test.example.org',showMeetingTools:false,professional:{links:[{label:'Email',href:'mailto:test@example.org'}]},personal:{links:[]},
 categories:[{id:'professional',label:'Professional',links:[{label:'Email',href:'mailto:test@example.org'}]},
 {id:'personal',label:'Personal',categories:[{id:'friends',label:'Friends',categories:[{id:'close',label:'Close',links:[{label:'Phone',href:'tel:+15555550123'}]}]}]},
 {id:'community',label:'Community',links:[]}],
 backend:{url:'https://test.supabase.co',publishableKey:'sb_publishable_test'}
})}});
const server = createServer((req,res)=>{
 const name = req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
 if (!/^[a-z0-9./-]+$/i.test(name) || name.includes('..')) { res.writeHead(404);res.end();return; }
 try { const data=readFileSync(join(root,'dist',name)); const ext=name.split('.').pop();res.setHeader('Content-Type',({html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml',webmanifest:'application/manifest+json'})[ext]||'text/plain');res.end(data); }
 catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const chrome=spawn(process.env.CHROMIUM||'chromium',['--headless','--no-sandbox','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+join(root,'chrome'),'about:blank'],{stdio:['ignore','ignore','pipe']});
const endpoint=await new Promise((resolve,reject)=>{
 let log='';const timer=setTimeout(()=>reject(new Error('Chromium startup timed out: '+log)),15000);
 chrome.stderr.on('data',buf=>{log+=buf;const m=log.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
 chrome.on('exit',code=>{clearTimeout(timer);reject(new Error('Chromium exited '+code+': '+log));});
});
class CDP {
 constructor(url){this.ws=new WebSocket(url);this.seq=0;this.pending=new Map();this.events=new Map();this.ready=new Promise(r=>this.ws.addEventListener('open',r));this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);}else this.events.get(m.method)?.(m.params);});}
 async call(method,params={}){await this.ready;return new Promise((resolve,reject)=>{const id=++this.seq;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
 close(){this.ws.close();}
}
const browser=new CDP(endpoint), clients=[];
const calls=[];
let pauseRefresh=false, releaseRefresh=null;
const mock=createMockBackend({failFirstPublicEvent:true});
const {api,events,messages,bugs,connections}=mock;
async function page(ctx,hash,installed=false){
 const {targetId}=await browser.call('Target.createTarget',{url:'about:blank',browserContextId:ctx});
 const list=await fetch('http://'+new URL(endpoint).host+'/json/list').then(r=>r.json());
 const client=new CDP(list.find(x=>x.id===targetId).webSocketDebuggerUrl);clients.push(client);
 await client.call('Page.enable');await client.call('Runtime.enable');
 await client.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 if(installed)await client.call('Page.addScriptToEvaluateOnNewDocument',{source:`const mm=window.matchMedia.bind(window);window.matchMedia=q=>q==='(display-mode: standalone)'?{matches:true}:mm(q);`});
 await client.call('Fetch.enable',{patterns:[{urlPattern:'https://test.supabase.co/*'}]});
 client.events.set('Fetch.requestPaused',async({requestId,request})=>{
  let status=200,result;
  try{
   if(request.method==='OPTIONS')result=null;
   else {const p=JSON.parse(request.postData||'{}'),name=new URL(request.url).pathname+new URL(request.url).search;const authorized=Object.entries(request.headers).some(([k,v])=>k.toLowerCase()==='authorization'&&v==='Bearer owner-access');calls.push({ctx,name,p,authorized});if(pauseRefresh&&name.includes('grant_type=refresh_token'))await new Promise(resolve=>{releaseRefresh=resolve;});result=api(name,p,authorized);}
  }catch(err){status=err.status||500;result={message:err.message};}
  try{await client.call('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Headers',value:'*'},{name:'Access-Control-Allow-Methods',value:'POST,OPTIONS'}],body:Buffer.from(JSON.stringify(result)).toString('base64')});}catch{}
 });
 await client.call('Page.navigate',{url:origin+'/'+hash});
 await wait(()=>client.eval(`!!document.getElementById('panel-home') && document.querySelector('.panel.is-active') !== null`));
 return client;
}
async function wait(fn,ms=12000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Condition timed out');}
try {
 const {browserContextId:publicCtx}=await browser.call('Target.createBrowserContext');
 const publicPage=await page(publicCtx,'#/professional');
 await wait(()=>events.some(e=>!e.connection_id));
 await publicPage.eval(`document.querySelector('.link').addEventListener('click',e=>e.preventDefault());document.querySelector('.link').click();`);
 await wait(()=>events.some(e=>!e.connection_id&&e.kind==='contact_click'));
 assert.ok(!calls.some(c=>c.ctx===publicCtx&&/get_|list_/.test(c.name)),'Unsolicited visitors must never read data');
 assert.ok(mock.failedEvent,'Failed write exercised retry queue');
 console.log('PASS public UI events, failed-write retry, no public reads');
 const {browserContextId:ownerCtx}=await browser.call('Target.createBrowserContext');
 const ownerPage=await page(ownerCtx,'#/owner',true);
 await browser.call('Browser.grantPermissions',{origin,permissions:['geolocation'],browserContextId:ownerCtx});
 await ownerPage.call('Emulation.setGeolocationOverride',{latitude:29.9627,longitude:-90.0606,accuracy:20});
 await ownerPage.eval(`document.querySelector('[name=email]').value='demo@example.org';document.querySelector('[name=password]').value='demo';document.getElementById('owner-login').requestSubmit();`);
 await wait(()=>ownerPage.eval(`!document.getElementById('owner-tools').hidden`));
 await ownerPage.eval(`document.getElementById('new-session').click()`);
 await wait(()=>connections.length===1&&ownerPage.eval(`location.hash==='#/qr'`));
 await wait(()=>connections[0].latitude!==null);
 const c=connections[0];
 const screenshot=(await ownerPage.call('Page.captureScreenshot',{format:'png'})).data;
 const screenshotPath=join(root,'conversation-qr.png');writeFileSync(screenshotPath,Buffer.from(screenshot,'base64'));
 assert.equal(execFileSync('zbarimg',['--quiet','--raw',screenshotPath],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(),origin+'/#/meet/'+c.invite_token);
 console.log('PASS owner sign-in, conversation creation, private location and rendered QR decoding');
 const {browserContextId:guestCtx}=await browser.call('Target.createBrowserContext');
 const guest=await page(guestCtx,'#/meet/'+c.invite_token);
 assert.ok(await guest.eval(`document.getElementById('owner-entry')===null&&!document.getElementById('invitee-conversation').open`));
 await wait(()=>events.some(e=>e.connection_id===c.id&&e.kind==='page_open'));
 await guest.eval(`document.querySelector('.choice').click()`);
 assert.equal(await guest.eval('location.hash'),'#/meet/'+c.invite_token+'/professional');
 await guest.eval(`document.querySelector('.link').addEventListener('click',e=>e.preventDefault());document.querySelector('.link').click()`);
 await wait(()=>events.some(e=>e.connection_id===c.id&&e.kind==='contact_click'));
 assert.deepEqual(events.find(e=>e.connection_id===c.id&&e.kind==='contact_click').details.path,['Professional','Email']);
 await guest.eval(`location.hash='#/meet/${c.invite_token}/personal/friends/close'`);
 await wait(()=>guest.eval(`document.querySelector('[data-category-panel="personal/friends/close"]').classList.contains('is-active')`));
 await guest.eval(`const a=document.querySelector('[data-category-panel="personal/friends/close"] a.link');a.addEventListener('click',e=>e.preventDefault());a.click();`);
 await wait(()=>events.some(e=>e.details.path?.join(' > ')==='Personal > Friends > Close > Phone > Call'));
 await guest.eval(`document.getElementById('floating-back').click()`);
 assert.equal(await guest.eval('location.hash'),'#/meet/'+c.invite_token+'/personal/friends');
 assert.ok(await guest.eval(`Array.from(document.querySelectorAll('a.link')).every(a=>a.target==='_blank'&&a.rel.includes('noopener'))`));
 await guest.eval(`location.hash='#/meet/${c.invite_token}/personal/friends/close'`);
 await wait(()=>guest.eval(`document.querySelector('[data-category-panel="personal/friends/close"]').classList.contains('is-active')`));
 assert.ok(await guest.eval(`document.querySelector('[data-category-panel="personal/friends/close"] a[href^="sms:"]').getAttribute('href')==='sms:+15555550123'`));
 await guest.eval(`{const textLink=document.querySelector('[data-category-panel="personal/friends/close"] a[href^="sms:"]');textLink.addEventListener('click',e=>e.preventDefault());textLink.click();}`);
 await wait(()=>events.some(e=>e.details.path?.join(' > ')==='Personal > Friends > Close > Phone > Text'));
 console.log('PASS external tab targets and separate Call/Text events');
 console.log('PASS three roots, nested invitation routes, complete contact hierarchy and parent navigation');
 await ownerPage.eval(`location.hash='#/owner'`);
 await wait(()=>ownerPage.eval(`!document.getElementById('session-editor').hidden`));
 await ownerPage.eval(`document.getElementById('session-label').value='Meetup person';document.getElementById('session-notes').value='Owner-only meeting detail 7f3c';document.getElementById('session-notes').dispatchEvent(new Event('input'));document.getElementById('notes-form').requestSubmit()`);
 await wait(()=>c.notes==='Owner-only meeting detail 7f3c');
 assert.ok(await ownerPage.eval(`document.getElementById('owner-status').textContent==='Conversation: Meetup person'`));
 await ownerPage.eval(`location.hash='#/professional'`);
 await wait(()=>ownerPage.eval(`document.querySelector('[data-category-panel="professional"]').classList.contains('is-active')`));
 await ownerPage.eval(`document.getElementById('qr-nav').click()`);
 assert.equal(await ownerPage.eval('location.hash'),'#/owner');
 await ownerPage.eval(`document.getElementById('show-session-qr').click()`);
 assert.equal(await ownerPage.eval('location.hash'),'#/qr');
 assert.equal(await ownerPage.eval(`document.getElementById('qr-session-label').textContent`),'Meetup person');
 assert.equal(await ownerPage.eval(`document.getElementById('qr-session-created').dateTime`),c.created_at);
 await ownerPage.eval(`location.hash='#/owner'`);
 console.log('PASS signed-in QR navigation selects a conversation first; QR shows saved name and creation time');

 assert.ok(await ownerPage.eval(`document.getElementById('session-editor').tagName==='DETAILS'&&document.getElementById('session-editor').contains(document.getElementById('conversation-messages'))`));
 assert.ok(await ownerPage.eval(`document.getElementById('owner-tools').firstElementChild.querySelector('#new-session')!==null&&document.getElementById('owner-tools').children[1].querySelector('#session-list')!==null`));
 await ownerPage.eval(`window.savedGeolocation=navigator.geolocation.getCurrentPosition;navigator.geolocation.getCurrentPosition=(ok,fail)=>fail({code:3,message:'Timed out'});document.getElementById('retry-location').click()`);
 await wait(()=>ownerPage.eval(`document.getElementById('session-info').textContent.includes('timed out')`));
 await ownerPage.eval(`navigator.geolocation.getCurrentPosition=window.savedGeolocation;document.getElementById('retry-location').click()`);
 await wait(()=>ownerPage.eval(`document.getElementById('session-info').textContent.includes('29.96270')&&!document.getElementById('retry-location').disabled`));
 await wait(()=>ownerPage.eval(`document.getElementById('session-events').textContent.includes('Location updated · from')`));
 assert.ok(events.some(e=>e.kind==='location_update'&&e.details.from.latitude===29.9627&&e.details.to.latitude===29.9627));
 console.log('PASS conversation nesting, recent conversations first, named status, location retry and from/to history');

 writeFileSync(join(root,'meeting-tools.png'),Buffer.from((await ownerPage.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await ownerPage.eval(`document.getElementById('message-body').value='<img src=x onerror=alert(1)> Project discussed';document.getElementById('message-url').value='https://example.org/project';document.getElementById('message-form').requestSubmit()`);
 await wait(()=>messages.length===1);
 await guest.call('Page.bringToFront');
 await wait(()=>guest.eval(`document.querySelector('#shared-list a')?.href==='https://example.org/project'`));
 assert.equal(await guest.eval(`document.querySelector('#shared-list img')===null`),true,'Message content must be rendered as text');
 assert.equal(await guest.eval(`document.body.textContent.includes('Owner-only meeting detail 7f3c')`),false);
 await wait(()=>events.some(e=>e.kind==='message_received'));
 await guest.eval(`document.querySelector('#shared-list a').addEventListener('click',e=>e.preventDefault());document.querySelector('#shared-list a').click()`);
 await wait(()=>events.some(e=>e.kind==='message_click'));
 await ownerPage.call('Page.bringToFront');
 await wait(()=>ownerPage.eval(`document.getElementById('owner-messages').textContent.includes('Received by page')`));
 console.log('PASS invited routes, contact events, private notes, live message/link delivery and receipt');
 const reopened=await page(guestCtx,'#/meet/'+c.invite_token);
 await reopened.call('Page.bringToFront');await wait(()=>reopened.eval(`document.querySelector('#shared-list a')!==null`));
 await wait(()=>reopened.eval(`document.getElementById('shared-heading').textContent==='Conversation with Meetup person'`));
 assert.ok(await reopened.eval(`!document.getElementById('shared-status').textContent.includes('These messages')`));
 console.log('PASS shared messages persist on reopening invitation and use the saved conversation name');
 await reopened.eval(`document.getElementById('invitee-message-body').value='<img src=x onerror=alert(1)> Invitee reply';document.getElementById('invitee-message-body').dispatchEvent(new Event('input'));document.getElementById('invitee-message-form').requestSubmit()`);
 await wait(()=>messages.some(m=>m.sender==='invitee'));
 await wait(()=>reopened.eval(`document.getElementById('shared-list').textContent.includes('Invitee reply')`));
 assert.equal(await reopened.eval(`document.querySelectorAll('#shared-list img').length`),0);
 await ownerPage.call('Page.bringToFront');
 await wait(()=>ownerPage.eval(`document.getElementById('owner-messages').textContent.includes('Invitee reply')`));
 assert.ok(await ownerPage.eval(`document.getElementById('owner-messages').textContent.includes('Invitee')`));
 const reopenedReply=await page(guestCtx,'#/meet/'+c.invite_token);
 await reopenedReply.call('Page.bringToFront');
 await wait(()=>reopenedReply.eval(`document.getElementById('shared-list').textContent.includes('Invitee reply')`));
 assert.ok(!events.some(e=>e.kind==='message_received'&&e.details.message_id===messages.find(m=>m.sender==='invitee').id));
 console.log('PASS invitee replies, sender labels, safe rendering, owner delivery and persistence');
 await ownerPage.call('Page.bringToFront');
 assert.ok(await ownerPage.eval(`document.querySelector('#owner-messages > li').textContent.includes('Invitee reply')`));
 const publicGroups=new Set(events.filter(e=>!e.connection_id).map(e=>e.visitor_id)).size;
 await ownerPage.eval(`document.getElementById('session-editor').open=false;document.getElementById('conversation-messages').open=false;document.getElementById('conversation-activity').open=false;document.getElementById('public-activity').open=true`);
 await wait(()=>ownerPage.eval(`document.querySelectorAll('#public-events details').length===${publicGroups}`));
 assert.ok(await ownerPage.eval(`!document.querySelector('#public-events details').open`));
 const secondVisitor=crypto.randomUUID();
 events.push({id:crypto.randomUUID(),visitor_id:secondVisitor,connection_id:null,kind:'page_open',details:{},created_at:new Date().toISOString()});
 await ownerPage.eval(`document.querySelector('#public-events details').open=true;document.getElementById('public-activity').open=false`);
 await new Promise(r=>setTimeout(r,100));
 await ownerPage.eval(`document.getElementById('public-activity').open=true`);
 await wait(()=>ownerPage.eval(`document.querySelectorAll('#public-events details').length===${publicGroups+1}`));
 assert.equal(await ownerPage.eval(`document.querySelectorAll('#public-events details[open]').length`),1);
 assert.equal(await ownerPage.eval(`document.querySelector('#public-events details').dataset.visitor`),secondVisitor);
 await new Promise(r=>setTimeout(r,3200));
 assert.ok(await ownerPage.eval(`!document.getElementById('session-editor').open&&!document.getElementById('conversation-messages').open&&!document.getElementById('conversation-activity').open`));
 console.log('PASS newest messages, persistent collapsed sections, and visitor groups closed by default');


 await ownerPage.call('Page.bringToFront');
 await ownerPage.call('Network.enable');
 await ownerPage.call('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await ownerPage.eval(`document.getElementById('bug-toggle').click();document.getElementById('bug-description').value='Report captured offline';document.getElementById('bug-form').requestSubmit()`);
 await wait(()=>ownerPage.eval(`!document.getElementById('bug-dialog').open`));
 assert.equal(bugs.length,0);
 await ownerPage.call('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await wait(()=>bugs.length===1);
 assert.equal(bugs[0].description,'Report captured offline');assert.ok(bugs[0].context.version);
 console.log('PASS offline bug capture and automatic sync');
 const relaunched=await page(ownerCtx,'#/qr',true);await relaunched.call('Page.bringToFront');
 await wait(()=>connections.length===2);assert.notEqual(connections[1].invite_token,c.invite_token);
 await relaunched.eval(`location.hash='#/owner'`);await new Promise(r=>setTimeout(r,300));await relaunched.eval(`location.hash='#/qr'`);
 assert.equal(connections.length,2,'Returning to QR must preserve current conversation');
 console.log('PASS installed owner launch creates a fresh conversation; navigation preserves it');
 assert.ok(await relaunched.eval(`document.getElementById('qr-owner-tools').hidden`));
 await relaunched.eval(`for(let i=0;i<4;i++)document.querySelector('.qr-domain').click()`);
 assert.equal(await relaunched.eval('location.hash'),'#/qr');
 await new Promise(r=>setTimeout(r,3100));
 await relaunched.eval(`for(let i=0;i<4;i++)document.querySelector('.qr-domain').click()`);
 assert.equal(await relaunched.eval('location.hash'),'#/qr');
 await relaunched.eval(`document.querySelector('.qr-domain').click()`);
 assert.equal(await relaunched.eval('location.hash'),'#/owner');
 console.log('PASS compact conversation and hidden tools shortcut requiring five taps within three seconds');
 await relaunched.eval(`window.inlineInjectionRan=false;const injected=document.createElement('script');injected.textContent='window.inlineInjectionRan=true';document.body.append(injected);`);
 assert.equal(await relaunched.eval('window.inlineInjectionRan'),false,'CSP blocks injected inline scripts');
 await relaunched.eval(`const key=Object.keys(localStorage).find(k=>k.endsWith(':auth'));const state=JSON.parse(localStorage.getItem(key));state.expires_at=0;localStorage.setItem(key,JSON.stringify(state));`);
 pauseRefresh=true;
 const refreshingPage=await page(ownerCtx,'#/owner');
 await wait(()=>releaseRefresh!==null);
 await refreshingPage.eval(`document.getElementById('owner-logout').click()`);
 pauseRefresh=false;releaseRefresh();
 await wait(()=>refreshingPage.eval(`!Object.keys(localStorage).some(k=>k.endsWith(':auth'))`));
 await new Promise(r=>setTimeout(r,500));
 assert.ok(await refreshingPage.eval(`document.getElementById('owner-tools').hidden&&!Object.keys(localStorage).some(k=>k.endsWith(':auth'))`));
 console.log('PASS CSP script injection defense and sign-out during in-flight token refresh');


 console.log('Screenshots and fixture: '+root);
} finally {
 clients.forEach(c=>c.close());await browser.call('Browser.close').catch(()=>{});browser.close();chrome.kill();await new Promise(r=>server.close(r));
}
