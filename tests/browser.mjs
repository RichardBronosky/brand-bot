// Real Chromium UI regression test; Supabase HTTP responses are mocked.
// Requires Node 22+, chromium and zbarimg. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync('/tmp/brand-browser-test-');
mkdirSync(join(root, 'vendor'));
for (const f of ['build.mjs','template.html','sw.js','app.js','app.css','vendor/qrcodegen.js','qr.svg']) copyFileSync(join(source,f),join(root,f));
execFileSync(process.execPath,[join(root,'build.mjs')],{env:{...process.env,BRAND_CONFIG:JSON.stringify({
 name:'Meeting Test',domain:'test.example.org',professional:{links:[{label:'Email',href:'mailto:test@example.org'}]},personal:{links:[]},
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
const calls=[],events=[],messages=[],bugs=[],connections=[];
let failedEvent=false;
const now=()=>new Date().toISOString();
function api(name,p,authorized){
 if(name.startsWith('/auth/v1/token')) return {access_token:'owner-access',refresh_token:'owner-refresh',expires_in:3600,user:{id:'11111111-1111-4111-8111-111111111111'}};
 if(name.startsWith('/auth/v1/logout')) return null;
 const fn=name.split('brand_')[1];
 if(!['record_event','get_messages'].includes(fn)&&!authorized)throw Object.assign(new Error('Owner required'),{status:403});
 switch(fn){
 case 'list_connections':return connections.slice().reverse().map(c=>({...c,opens:events.filter(e=>e.connection_id===c.id&&e.kind==='page_open').length}));
 case 'create_connection': {const c={id:crypto.randomUUID(),invite_token:crypto.randomUUID(),created_at:now(),latitude:null,longitude:null,label:'',notes:''};connections.push(c);return c;}
 case 'set_location':Object.assign(connections.find(c=>c.id===p.p_id),{latitude:p.p_latitude,longitude:p.p_longitude});return null;
 case 'update_connection':Object.assign(connections.find(c=>c.id===p.p_id),{label:p.p_label,notes:p.p_notes});return null;
 case 'get_connection':return{connection:connections.find(c=>c.id===p.p_id),events:events.filter(e=>e.connection_id===p.p_id),messages:messages.filter(m=>m.connection_id===p.p_id)};
 case 'record_event':{
  if(!failedEvent && p.p_token===null){failedEvent=true;throw Object.assign(new Error('Temporary outage'),{status:503});}
  const c=p.p_token&&connections.find(c=>c.invite_token===p.p_token);
  if(p.p_token&&!c)throw Object.assign(new Error('Invalid invitation'),{status:400});
  if(!events.some(e=>e.id===p.p_id)) events.push({id:p.p_id,kind:p.p_kind,details:p.p_details,visitor_id:p.p_visitor_id,connection_id:c?.id||null,created_at:now()});return null;
 }
 case 'send_message':messages.push({id:messages.length+1,connection_id:p.p_id,body:p.p_body,url:p.p_url,created_at:now()});return null;
 case 'get_messages':{const c=connections.find(c=>c.invite_token===p.p_token);if(!c)throw Object.assign(new Error('Invalid invitation'),{status:400});return messages.filter(m=>m.connection_id===c.id&&m.id>p.p_after).map(({connection_id,...m})=>m);}
 case 'get_public_events':return events.filter(e=>!e.connection_id).reverse();
 case 'report_bug':if(!bugs.some(b=>b.id===p.p_id))bugs.push({id:p.p_id,description:p.p_description,context:p.p_context,created_at:now()});return null;
 case 'list_bugs':return bugs;
 default:throw new Error('Unhandled '+name);
 }
}
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
   else {const p=JSON.parse(request.postData||'{}'),name=new URL(request.url).pathname+new URL(request.url).search;const authorized=Object.entries(request.headers).some(([k,v])=>k.toLowerCase()==='authorization'&&v==='Bearer owner-access');calls.push({ctx,name,p,authorized});result=api(name,p,authorized);}
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
 assert.ok(failedEvent,'Failed write exercised retry queue');
 console.log('PASS public UI events, failed-write retry, no public reads');
 const {browserContextId:ownerCtx}=await browser.call('Target.createBrowserContext');
 const ownerPage=await page(ownerCtx,'#/owner',true);
 await browser.call('Browser.grantPermissions',{origin,permissions:['geolocation'],browserContextId:ownerCtx});
 await ownerPage.call('Emulation.setGeolocationOverride',{latitude:29.9627,longitude:-90.0606,accuracy:20});
 await ownerPage.eval(`document.querySelector('[name=email]').value='owner@example.org';document.querySelector('[name=password]').value='test-password';document.getElementById('owner-login').requestSubmit();`);
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
 await wait(()=>events.some(e=>e.connection_id===c.id&&e.kind==='page_open'));
 await guest.eval(`document.querySelector('.choice').click()`);
 assert.equal(await guest.eval('location.hash'),'#/meet/'+c.invite_token+'/professional');
 await guest.eval(`document.querySelector('.link').addEventListener('click',e=>e.preventDefault());document.querySelector('.link').click()`);
 await wait(()=>events.some(e=>e.connection_id===c.id&&e.kind==='contact_click'));
 await ownerPage.eval(`location.hash='#/owner'`);
 await wait(()=>ownerPage.eval(`!document.getElementById('session-editor').hidden`));
 await ownerPage.eval(`document.getElementById('session-label').value='Meetup person';document.getElementById('session-notes').value='Owner-only meeting detail 7f3c';document.getElementById('session-notes').dispatchEvent(new Event('input'));document.getElementById('notes-form').requestSubmit()`);
 await wait(()=>c.notes==='Owner-only meeting detail 7f3c');
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
 console.log('PASS shared messages persist on reopening invitation');
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
 console.log('Screenshots and fixture: '+root);
} finally {
 clients.forEach(c=>c.close());await browser.call('Browser.close').catch(()=>{});browser.close();chrome.kill();await new Promise(r=>server.close(r));
}
