'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const initSqlJs = require('sql.js');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'phase2-sdk-isolated-test-secret-no-production-use';
const { SECRET } = require('../middleware/auth');
const { apiV1Middleware, apiV1Router } = require('../lib/apiV1');
const { hashPassword } = require('../lib/password');
const sdk = import('../../sdk/mobile-client.mjs');
const header = { 'Content-Type':'application/json', 'X-API-Version':'1', 'X-Request-ID':'mock-request' };
function success(data, status = 200) { return new Response(JSON.stringify({data,error:null,meta:{apiVersion:'1',requestId:'mock-request'}}),{status,headers:header}); }
function failure(status, code, details) { return new Response(JSON.stringify({data:null,error:{code,message:'localized error',...(details?{details}:{})},meta:{apiVersion:'1',requestId:'mock-request'}}),{status,headers:{...header,'Retry-After':'12'}}); }
async function mockClient(extra={}) {
  const { createMobileClient } = await sdk;
  const calls=[];
  const client=createMobileClient({baseURL:'https://school.invalid/api/v1/',getToken:()=> 'caller-token',getWallId:()=>7,fetch:async(url,options)=>{calls.push({url,options});return success({ok:true});},...extra});
  return {client,calls};
}

test('phase2 SDK: injected fetch receives exact version URL, scalar query and caller credentials',async()=>{
  let token='first';
  const {client,calls}=await mockClient({getToken:async()=>token});
  const result=await client.getMessages(12,{after:3,mark_read:0,q:undefined});
  assert.equal(calls[0].url,'https://school.invalid/api/v1/messages/conversation/12?after=3&mark_read=0');
  assert.equal(calls[0].options.headers.Authorization,'Bearer first');
  assert.equal(calls[0].options.headers['X-Wall-Id'],'7');
  assert.equal(calls[0].options.credentials,'omit');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.cache,'no-store');
  assert.equal(result.status,200);assert.deepEqual(result.data,{ok:true});assert.equal(result.meta.requestId,'mock-request');
  token='rotated';await client.getMe({wallId:null});
  assert.equal(calls[1].options.headers.Authorization,'Bearer rotated');
  assert.equal('X-Wall-Id' in calls[1].options.headers,false);
});

test('phase2 SDK: login does not read/store a token or leak a selected wall',async()=>{
  const {client,calls}=await mockClient({getToken:()=>{throw Error('must not read');},getWallId:()=>{throw Error('must not read');}});
  await client.login({username:'input-from-user',password:'caller-supplied'});
  assert.equal(calls[0].options.method,'POST');
  assert.equal('Authorization' in calls[0].options.headers,false);
  assert.equal('X-Wall-Id' in calls[0].options.headers,false);
  assert.deepEqual(JSON.parse(calls[0].options.body),{username:'input-from-user',password:'caller-supplied'});
  await client.getCapabilities();assert.equal(calls[1].url,'https://school.invalid/api/v1/capabilities');
});

test('phase2 SDK: preference reset/schema, read/delete/revoke and upload methods match real verbs',async()=>{
  const {client,calls}=await mockClient();
  await client.getPreferencesSchema();await client.updatePreferences({chat_density:'compact'});await client.resetPreferences('chat');
  await client.readMessage(2);await client.readMessages([2,3]);await client.readAllMessages('private');
  await client.deleteMessage(2);await client.deleteConversation(12);await client.revokeMessage(3);
  await client.uploadImage('data');await client.uploadPrivateImage('data');await client.uploadAvatar('data');
  assert.deepEqual(calls.map(c=>[new URL(c.url).pathname,c.options.method??'GET']),[
    ['/api/v1/auth/prefs/schema','GET'],['/api/v1/auth/prefs','PUT'],['/api/v1/auth/prefs/reset','POST'],
    ['/api/v1/messages/2/read','PUT'],['/api/v1/messages/read-batch','PUT'],['/api/v1/messages/read-all','PUT'],
    ['/api/v1/messages/2','DELETE'],['/api/v1/messages/chat/12','DELETE'],['/api/v1/messages/3/revoke','PUT'],
    ['/api/v1/upload/image','POST'],['/api/v1/upload/bug-image','POST'],['/api/v1/avatar/upload','PUT']]);
  assert.deepEqual(JSON.parse(calls[1].options.body),{prefs:{chat_density:'compact'}});
  assert.deepEqual(JSON.parse(calls[2].options.body),{scope:'chat'});
});

test('phase2 SDK: remaining helpers retain exact query and business body contracts',async()=>{
  const {client,calls}=await mockClient();
  await client.getWalls();await client.discoverWalls({q:'space & 中文'});await client.getWall(2);await client.joinWall(2);await client.leaveWall(2);
  await client.getPosts({page:2,limit:50,sort:'hot'});await client.searchPosts('a%_');await client.getPost(9,{comments_page:2,comments_limit:50});
  await client.createPost({content:'post'});await client.createComment(9,'comment');await client.getConversations({before:10});
  await client.getFriends();await client.getPendingFriends();await client.addFriend(2);await client.respondToFriend(7,'accept');
  await client.getVotes({limit:5});await client.getVote(2);await client.createVote({title:'vote',options:['a','b']});await client.castVote(2,3);
  await client.updateProfile({nickname:'caller-chosen'});await client.changePassword({oldPassword:'old',newPassword:'new-password'});
  assert.equal(calls.length,21);
  assert.equal(new URL(calls[1].url).searchParams.get('q'),'space & 中文');
  assert.equal(calls[7].url.endsWith('/posts/9?comments_page=2&comments_limit=50'),true);
  assert.deepEqual(JSON.parse(calls[9].options.body),{content:'comment'});
  assert.deepEqual(JSON.parse(calls[14].options.body),{action:'accept'});
  assert.deepEqual(JSON.parse(calls[18].options.body),{option_id:3});
});

test('phase2 SDK: HTTP/business errors keep status, details, correlation and retry-after',async()=>{
  const {ApiError}=await sdk;
  const {client}=await mockClient({fetch:async()=>failure(403,'BANNED',{scope:'wall',until:'private-time'})});
  await assert.rejects(client.getMe(),error=>error instanceof ApiError&&error.status===403&&error.code==='BANNED'&&error.details.scope==='wall'&&error.requestId==='mock-request'&&error.retryAfter==='12');
});

test('phase2 SDK: invalid/missing/legacy envelopes and non-JSON fail explicitly',async()=>{
  for(const response of [new Response('<html>proxy</html>',{status:502}),new Response(JSON.stringify({id:1}),{status:200}),new Response(JSON.stringify({data:1,error:null,meta:{apiVersion:'2',requestId:'x'}}),{status:200})]){
    const status=response.status;const {client}=await mockClient({fetch:async()=>response});
    await assert.rejects(client.getMe(),error=>error.code==='INVALID_RESPONSE'&&error.status===status);
  }
});

test('phase2 SDK: timeout, provider timeout and AbortSignal stop without retries',async()=>{
  let calls=0;
  const {client}=await mockClient({timeoutMs:10,fetch:()=>{calls++;return new Promise(()=>{});}});
  await assert.rejects(client.getMe(),error=>error.code==='TIMEOUT'&&error.status===0);assert.equal(calls,1);
  const provider=await mockClient({timeoutMs:10,getToken:()=>new Promise(()=>{})});
  await assert.rejects(provider.client.getMe(),error=>error.code==='TIMEOUT');assert.equal(provider.calls.length,0);
  const controller=new AbortController();controller.abort();
  const before=await mockClient();await assert.rejects(before.client.getMe({signal:controller.signal}),error=>error.code==='ABORTED');assert.equal(before.calls.length,0);
  const during=new AbortController();const pending=client.getMe({signal:during.signal,timeoutMs:0});during.abort();
  await assert.rejects(pending,error=>error.code==='ABORTED');
});

test('phase2 SDK: no implicit retry of a failed write; caller can safely reuse prepared cid',async()=>{
  const {ApiError}=await sdk;let requests=0;const bodies=[];
  const {client}=await mockClient({crypto:{randomUUID:()=> 'fixed-secure-test-id'},fetch:async(url,options)=>{
    requests++;bodies.push(JSON.parse(options.body));if(requests===1)throw Error('response lost');return success({id:44,deduplicated:true,client_message_id:bodies[0].client_message_id});
  }});
  const prepared=client.prepareMessage({receiver_id:12,content:'one message',reply_to_id:4});assert.equal(Object.isFrozen(prepared),true);
  await assert.rejects(client.sendMessage(prepared),error=>error instanceof ApiError&&error.code==='NETWORK_ERROR'&&error.clientMessageId===prepared.client_message_id);
  assert.equal(requests,1);
  const result=await client.sendMessage(prepared);assert.equal(requests,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal(result.clientMessageId,prepared.client_message_id);assert.equal(result.data.deduplicated,true);
});

test('phase2 SDK: secure cid generation and explicit cid remain usable without global crypto',async()=>{
  const {createClientMessageId}=await sdk;
  const key=createClientMessageId({getRandomValues:bytes=>{bytes.fill(1);return bytes;}});assert.equal(key,'swm-'+ '01'.repeat(16));
  assert.throws(()=>createClientMessageId({}),error=>error.code==='CRYPTO_UNAVAILABLE');
  const {client}=await mockClient({crypto:{}});
  assert.equal((await client.sendMessage({receiver_id:12,content:'hello',client_message_id:'caller-cid'})).clientMessageId,'caller-cid');
  for(const key of ['', 'has space', 'x'.repeat(129),'非ASCII'])assert.throws(()=>client.prepareMessage({receiver_id:12,content:'test',client_message_id:key}),error=>error.code==='CLIENT_VALIDATION');
});

test('phase2 SDK: URL/path/header validation prevents changing bearer destination',async()=>{
  const {createMobileClient}=await sdk;
  for(const baseURL of ['//outside.invalid/api/v1','javascript:alert(1)','https://user:password@school.invalid/api/v1','https://school.invalid/api/v1?secret=x','https://school.\ninvalid/api/v1','http://[malformed'])assert.throws(()=>createMobileClient({baseURL,fetch:async()=>success({})}));
  const {client,calls}=await mockClient();
  for(const target of ['https://outside.invalid','//outside.invalid','/../auth/me','/%2e%2e/auth/me','/auth/me?x=y'])await assert.rejects(client.request(target),error=>error.code==='CLIENT_VALIDATION');
  await assert.rejects(client.request('/posts',{query:{page:[1]}}),error=>error.code==='CLIENT_VALIDATION');
  await assert.rejects(client.getMe({token:'bad\nheader'}),error=>error.code==='CLIENT_VALIDATION');
  await assert.rejects(client.request('/posts',{method:'POST',body:()=>{}}),error=>error.code==='CLIENT_VALIDATION');
  assert.throws(()=>client.getPost('1/../../me'),error=>error.code==='CLIENT_VALIDATION');assert.equal(calls.length,0);
});

function wrap(memory){return {db:memory,exec:sql=>memory.run(sql),prepare(sql){const all=(...params)=>{const statement=memory.prepare(sql);try{statement.bind(params);const rows=[];while(statement.step())rows.push(statement.getAsObject());return rows;}finally{statement.free();}};return {all,get:(...params)=>all(...params)[0],run(...params){memory.run(sql,params);const changes=memory.getRowsModified();return {changes,lastInsertRowid:memory.exec('SELECT last_insert_rowid()')[0]?.values[0][0]||0};}};}};}
function loopbackFetch(url,options={}){
  return new Promise((resolve,reject)=>{
    const parsed=new URL(url);if(parsed.hostname!=='127.0.0.1')return reject(Error('Test fetch only permits loopback'));
    const req=http.request({hostname:parsed.hostname,port:parsed.port,path:parsed.pathname+parsed.search,method:options.method??'GET',headers:options.headers,signal:options.signal},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });req.on('error',reject);req.end(options.body);
  });
}
async function fixture(t){
  const SQL=await initSqlJs();const memory=new SQL.Database();
  const source=fs.readFileSync(path.join(__dirname,'../db.js'),'utf8');const marker='wrapper.exec('+String.fromCharCode(96);const schema=source.split(marker)[1]?.split(String.fromCharCode(96)+');')[0];assert.ok(schema);
  memory.run(schema);memory.run("CREATE UNIQUE INDEX IF NOT EXISTS phase2_sdk_message_cid ON messages(sender_id,client_message_id) WHERE client_message_id IS NOT NULL AND client_message_id<>''");
  const db=wrap(memory);const password=await hashPassword('isolated-fixture-password');
  for(const userId of [1,2])db.prepare('INSERT INTO users (id,username,password_hash,nickname) VALUES (?,?,?,?)').run(userId,'phase2-fixture-'+userId,password,'fixture-'+userId);
  db.prepare("INSERT INTO settings (key,value) VALUES ('initialized','1')").run();db.prepare("INSERT INTO walls (id,name,owner_id) VALUES (1,'isolated-test-wall',1)").run();
  for(const userId of [1,2])db.prepare("INSERT INTO wall_members (wall_id,user_id,wall_role,status) VALUES (1,?,'member','active')").run(userId);
  const app=express();app.use(apiV1Middleware());app.use(express.json({limit:'128kb'}));app.use((req,res,next)=>{req.db=db;next();});app.use('/api',apiV1Router());
  for(const name of ['auth','messages','posts','votes','walls','friends'])app.use('/api/'+name,require('../routes/'+name));
  app.use((req,res)=>res.status(404).json({error:'not found'}));app.use((error,req,res,next)=>res.status(500).json({error:'isolated test failure'}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));memory.close();});
  const origin='http://127.0.0.1:'+server.address().port;const {createMobileClient}=await sdk;let token=null;
  const client=createMobileClient({baseURL:origin+'/api/v1',fetch:loopbackFetch,getToken:()=>token,getWallId:()=>1});
  return {db,client,origin,setToken:value=>{token=value;},asUser:userId=>createMobileClient({baseURL:origin+'/api/v1',fetch:loopbackFetch,getToken:()=>jwt.sign({id:userId,tv:0},SECRET,{expiresIn:'5m'}),getWallId:()=>1})};
}

test('phase2 SDK: real isolated v1 supports login, prefs/schema/reset and unchanged legacy payloads',async t=>{
  const {client,setToken,origin}=await fixture(t);
  await assert.rejects(client.getMe(),error=>error.status===401&&error.code==='UNAUTHENTICATED');
  const login=await client.login({username:'phase2-fixture-1',password:'isolated-fixture-password'});assert.ok(login.data.token);setToken(login.data.token);
  const me=await client.getMe();assert.equal(me.data.id,1);assert.equal(me.meta.apiVersion,'1');
  const prefs=await client.getPreferences();assert.equal(prefs.data.prefs.chat_poll_interval,'20');assert.ok(Array.isArray(prefs.data.storedKeys));
  const schema=await client.getPreferencesSchema();assert.equal(schema.data.version,1);assert.equal(Object.keys(schema.data.schema).length,39);assert.equal(schema.data.schema.theme_mode.default,'system');
  await client.updatePreferences({chat_density:'compact',theme_mode:'dark'});const reset=await client.resetPreferences('chat');assert.equal(reset.data.prefs.chat_density,'comfortable');assert.equal(reset.data.prefs.theme_mode,'dark');
  const legacy=await loopbackFetch(origin+'/api/auth/me',{headers:{Authorization:'Bearer '+login.data.token}});const raw=await legacy.json();assert.equal(raw.id,1);assert.equal('data' in raw,false);assert.equal(legacy.headers.get('X-API-Version'),null);
  const api=await client.getCapabilities();assert.equal(api.data.pagination.messages.cursors.includes('around_id'),true);
  const spec=await (await loopbackFetch(origin+'/api/v1/openapi.json')).json();assert.equal(spec.openapi,'3.0.3');assert.equal('data' in spec,false);
});

test('phase2 SDK: real quoted chat supports cid retry/conflict, search, polling, read, context and one-sided delete',async t=>{
  const {client,asUser,setToken,db}=await fixture(t);setToken(jwt.sign({id:1,tv:0},SECRET,{expiresIn:'5m'}));const peer=asUser(2);
  const prepared=client.prepareMessage({receiver_id:2,content:'original quoted message',client_message_id:'phase2-fixed-id'});
  const first=await client.sendMessage(prepared);assert.equal(first.data.deduplicated,false);
  const duplicate=await client.sendMessage(prepared);assert.equal(duplicate.data.id,first.data.id);assert.equal(duplicate.data.deduplicated,true);
  await assert.rejects(client.sendMessage({...prepared,content:'different'}),error=>error.status===409&&error.code==='CLIENT_MESSAGE_CONFLICT'&&error.clientMessageId===prepared.client_message_id);
  const reply=await peer.sendMessage({receiver_id:1,content:'answer',reply_to_id:first.data.id});
  assert.equal(reply.data.message_item.reply_to.available,true);assert.equal(reply.data.message_item.reply_to.content,'original quoted message');
  const list=await peer.getConversations();assert.equal(list.data.conversations[0].user_id,1);
  const searched=await peer.getMessages(1,{q:'quoted',mark_read:0});assert.equal(searched.data.messages.length,1);assert.equal(searched.data.messages[0].client_message_id,null);
  const around=await peer.getMessages(1,{around_id:first.data.id,mark_read:0});assert.equal(around.data.messages.length,2);
  const after=await client.getMessages(2,{after:first.data.id,mark_read:0});assert.equal(after.data.messages[0].id,reply.data.id);
  await client.readMessages([reply.data.id]);await client.readMessage(reply.data.id);await client.readAllMessages('private');
  await client.revokeMessage(first.data.id);const revoked=await peer.getMessages(1,{mark_read:0});assert.equal(revoked.data.messages.find(row=>row.id===reply.data.id).reply_to.available,false);
  await assert.rejects(client.sendMessage(prepared),error=>error.status===409&&error.code==='CLIENT_MESSAGE_UNAVAILABLE');
  await client.deleteMessage(reply.data.id);assert.equal((await client.getMessages(2,{mark_read:0})).data.messages.some(row=>row.id===reply.data.id),false);
  assert.equal((await peer.getMessages(1,{mark_read:0})).data.messages.some(row=>row.id===reply.data.id),true);
  await peer.deleteConversation(1);assert.equal((await peer.getMessages(1)).data.messages.length,0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c,2);
});

test('phase2 SDK: real selected-wall posts/comments/votes/friends remain reachable through the adapter',async t=>{
  const {client,setToken}=await fixture(t);setToken(jwt.sign({id:1,tv:0},SECRET,{expiresIn:'5m'}));
  assert.equal((await client.getWalls()).data.length,1);
  const post=await client.createPost({content:'SDK actual post'});const comment=await client.createComment(post.data.id,'SDK actual comment');
  const detail=await client.getPost(post.data.id,{comments_limit:50});assert.equal(detail.data.comments_total,1);assert.equal(detail.data.comments[0].id,comment.data.id);
  const vote=await client.createVote({title:'SDK actual vote',options:['one','two']});const poll=await client.getVote(vote.data.id);await client.castVote(poll.data.id,poll.data.options[0].id);
  assert.equal((await client.getVotes()).data.votes[0].total_votes,1);assert.deepEqual((await client.getFriends()).data,[]);
});

test('phase2 SDK: OpenAPI is 3.0.3, references resolve, IDs unique and implemented SDK routes documented',()=>{
  const document=JSON.parse(fs.readFileSync(path.join(__dirname,'../../docs/openapi.json'),'utf8'));assert.equal(document.openapi,'3.0.3');assert.equal(document.servers[0].url,'/api/v1');
  const visit=value=>{if(!value||typeof value!=='object')return;if(value.$ref){assert.ok(value.$ref.startsWith('#/'));let resolved=document;for(const part of value.$ref.slice(2).split('/'))resolved=resolved?.[part.replace(/~1/g,'/').replace(/~0/g,'~')];assert.notEqual(resolved,undefined,value.$ref);}for(const child of Object.values(value))visit(child);};visit(document);
  const ids=[];for(const [route,methods]of Object.entries(document.paths)){for(const operation of Object.values(methods)){ids.push(operation.operationId);for(const match of route.matchAll(/\{([^}]+)\}/g))assert.ok(operation.parameters?.some(p=>p.in==='path'&&p.name===match[1]&&p.required),route);}}
  assert.equal(ids.length,new Set(ids).size);assert.ok(ids.length>=50);assert.equal(Object.keys(document.components.schemas.Preferences.properties).length,39);
  for(const route of ['/auth/login','/auth/me','/auth/prefs/schema','/auth/prefs/reset','/posts/{id}','/messages/conversations','/messages/conversation/{userId}','/messages/{id}/revoke','/upload/bug-image'])assert.ok(document.paths[route],route);
});
