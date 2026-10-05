#!/usr/bin/env node
// Isolated, local-only preview of meeting tools. Never deploy this server.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createMockBackend } from './tests/mock-backend.mjs';
const source=dirname(fileURLToPath(import.meta.url));
const root=mkdtempSync('/tmp/brand-demo-');
mkdirSync(join(root,'vendor'));
for(const f of ['categories.mjs', 'build.mjs','template.html','sw.js','app.js','app.css','vendor/qrcodegen.js','qr.svg'])copyFileSync(join(source,f),join(root,f));
let config={name:'Meeting Demo',domain:'demo.example.org'};
try{config=JSON.parse(readFileSync(join(source,'config.json'),'utf8'));}catch{}
config.backend={url:'https://demo.supabase.co',publishableKey:'sb_publishable_demo'};
execFileSync(process.execPath,[join(root,'build.mjs')],{env:{...process.env,BRAND_CONFIG:JSON.stringify(config)},stdio:'ignore'});
const port=Number(process.argv[2]||8766);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Port must be between 1 and 65535');
const {api}=createMockBackend();
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 if(req.method==='POST'&&(path.startsWith('/rest/v1/rpc/brand_')||path.startsWith('/auth/v1/'))){
  res.setHeader('Content-Type','application/json');
  try{
   let body='';for await(const part of req){body+=part;if(body.length>25000)throw Object.assign(new Error('Payload too large'),{status:413});}
   res.end(JSON.stringify(api(req.url,JSON.parse(body||'{}'),req.headers.authorization==='Bearer owner-access')));
  }catch(err){res.statusCode=err.status||400;res.end(JSON.stringify({message:err.message}));}
  return;
 }
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 const name=path==='/'?'index.html':path.slice(1);
 if(!/^[a-z0-9./-]+$/i.test(name)||name.includes('..')){res.writeHead(404);res.end();return;}
 try{
  let data=readFileSync(join(root,'dist',name));
  if(name==='index.html'){
   // A relative API URL works on localhost and behind Tailscale's HTTPS proxy.
   // This override exists only in the isolated mock fixture, never production.
   data=Buffer.from(data.toString().replaceAll('https://demo.supabase.co','').replace('<body>',
    '<body><aside style="position:fixed;top:0;left:0;right:0;padding:4px;text-align:center;background:#6e4900;color:white;font:12px sans-serif;z-index:30">Local demo · mock data · sign in: demo@example.org / demo</aside>'));
  }
  const ext=name.split('.').pop();res.setHeader('Content-Type',({html:'text/html; charset=utf-8',js:'text/javascript',css:'text/css',svg:'image/svg+xml',webmanifest:'application/manifest+json'})[ext]||'text/plain');
  res.setHeader('Cache-Control','no-store');res.end(data);
 }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(port,'127.0.0.1',()=>{
 console.log(`Demo: http://127.0.0.1:${port}/#/owner`);
 console.log('Sign in: demo@example.org / demo');
 console.log('Mock database in memory; restarting discards demo sessions.');
 console.log('Use a separate browser/private window for the invitation URL.');
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
