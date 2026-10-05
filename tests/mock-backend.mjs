// Local preview/test data only. Production permissions live in supabase/schema.sql.
export function createMockBackend({failFirstPublicEvent=false}={}) {
const events=[],messages=[],bugs=[],connections=[];
let failedEvent=!failFirstPublicEvent;
const now=()=>new Date().toISOString();
function api(name,p,authorized){
 if(name.startsWith('/auth/v1/token')) {
 if(name.includes('grant_type=password') && (p.email !== 'demo@example.org' || p.password !== 'demo')) throw Object.assign(new Error('Use demo@example.org / demo'),{status:400});
 return {access_token:'owner-access',refresh_token:'owner-refresh',expires_in:3600,user:{id:'11111111-1111-4111-8111-111111111111'}};
 }
 if(name.startsWith('/auth/v1/logout')) return null;
 const fn=name.split('brand_')[1];
 if(!['record_event','get_messages','send_invitee_message','get_conversation_label'].includes(fn)&&!authorized)throw Object.assign(new Error('Owner required'),{status:403});
 switch(fn){
 case 'list_connections':return connections.slice().reverse().map(c=>({...c,opens:events.filter(e=>e.connection_id===c.id&&e.kind==='page_open').length}));
 case 'create_connection': {const c={id:crypto.randomUUID(),invite_token:crypto.randomUUID(),created_at:now(),latitude:null,longitude:null,label:'',notes:''};connections.push(c);return c;}
 case 'set_location': {const c=connections.find(c=>c.id===p.p_id);const from={latitude:c.latitude,longitude:c.longitude,accuracy:c.location_accuracy??null};const to={latitude:p.p_latitude,longitude:p.p_longitude,accuracy:p.p_accuracy};Object.assign(c,{latitude:p.p_latitude,longitude:p.p_longitude,location_accuracy:p.p_accuracy});events.push({id:crypto.randomUUID(),connection_id:c.id,visitor_id:'11111111-1111-4111-8111-111111111111',kind:'location_update',details:{from,to},created_at:now()});return null;}
 case 'update_connection':Object.assign(connections.find(c=>c.id===p.p_id),{label:p.p_label,notes:p.p_notes});return null;
 case 'get_connection':return{connection:connections.find(c=>c.id===p.p_id),events:events.filter(e=>e.connection_id===p.p_id),messages:messages.filter(m=>m.connection_id===p.p_id)};
 case 'record_event':{
  if(!failedEvent && p.p_token===null){failedEvent=true;throw Object.assign(new Error('Temporary outage'),{status:503});}
  const c=p.p_token&&connections.find(c=>c.invite_token===p.p_token);
  if(p.p_token&&!c)throw Object.assign(new Error('Invalid invitation'),{status:400});
  if(!events.some(e=>e.id===p.p_id)) events.push({id:p.p_id,kind:p.p_kind,details:p.p_details,visitor_id:p.p_visitor_id,connection_id:c?.id||null,created_at:now()});return null;
 }
 case 'send_invitee_message': {const c=connections.find(c=>c.invite_token===p.p_token);if(!c||!p.p_body.trim()||p.p_body.length>4000)throw Object.assign(new Error('Invalid message or invitation'),{status:400});if(!messages.some(m=>m.request_id===p.p_request_id))messages.push({id:messages.length+1,connection_id:c.id,body:p.p_body,sender:'invitee',request_id:p.p_request_id,created_at:now()});return null;}
 case 'send_message':messages.push({sender:'owner',id:messages.length+1,connection_id:p.p_id,body:p.p_body,url:p.p_url,created_at:now()});return null;
 case 'get_conversation_label': {const c=connections.find(c=>c.invite_token===p.p_token);if(!c)throw Object.assign(new Error('Invalid invitation'),{status:400});return c.label;}
 case 'get_messages':{const c=connections.find(c=>c.invite_token===p.p_token);if(!c)throw Object.assign(new Error('Invalid invitation'),{status:400});return messages.filter(m=>m.connection_id===c.id&&m.id>p.p_after).map(({connection_id,request_id,...m})=>m);}
 case 'get_public_events':return events.filter(e=>!e.connection_id).reverse();
 case 'report_bug':if(!bugs.some(b=>b.id===p.p_id))bugs.push({id:p.p_id,description:p.p_description,context:p.p_context,created_at:now()});return null;
 case 'list_bugs':return bugs;
 default:throw new Error('Unhandled '+name);
 }
}
return {api, events, messages, bugs, connections, get failedEvent(){return failedEvent;}};
}
