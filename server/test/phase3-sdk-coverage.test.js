'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const document = JSON.parse(fs.readFileSync(path.join(root,'docs/openapi.json'),'utf8'));
const modules = Promise.all([import('../../sdk/mobile-client.mjs'), import('../../sdk/v1-operations.mjs')]);
const metadata = { apiVersion:'1', requestId:'isolated-sdk-coverage' };
const headers = { 'X-API-Version':'1', 'X-Request-ID':metadata.requestId };
function resolved(value) {
  while(value?.$ref) value=value.$ref.slice(2).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~')).reduce((node,key)=>node[key],document);
  return value;
}
function ordinaryOperations() {
  return Object.entries(document.paths).flatMap(([route,item])=>Object.entries(item).filter(([method,operation])=>['get','post','put','delete','patch','head','options'].includes(method)&&!operation['x-internal']&&route!=='/dashboard/session').map(([method,operation])=>({route,method:method.toUpperCase(),operation,item})));
}
function response(data) { return new Response(JSON.stringify({data,error:null,meta:metadata}),{status:200,headers:{...headers,'Content-Type':'application/json'}}); }

test('phase3 SDK: every ordinary v1 operation is registered exactly once and internal cookie operations are explicit exclusions', async()=>{
  const [{createMobileClient,ApiError},{V1_OPERATIONS}]=await modules;
  const expected=ordinaryOperations();
  assert.equal(expected.length,143);
  assert.deepEqual(Object.keys(V1_OPERATIONS).sort(),expected.map(entry=>entry.operation.operationId).sort());
  const api=createMobileClient({fetch:async()=>response({})});
  assert.deepEqual(Object.keys(api.operations).sort(),Object.keys(V1_OPERATIONS).sort());
  for(const id of ['__proto__','constructor','toString','absent']) assert.throws(()=>api.callOperation(id),error=>error instanceof ApiError&&error.code==='CLIENT_VALIDATION');
  for(const [route,item] of Object.entries(document.paths))for(const [method,operation] of Object.entries(item)) {
    if(!['get','post','put','delete','patch'].includes(method))continue;
    if(operation['x-internal']||route==='/dashboard/session')assert.equal(Object.hasOwn(V1_OPERATIONS,operation.operationId),false);
  }
});

test('phase3 SDK: all 143 operation entries dispatch the actual HTTP method and path without issuing real writes', async()=>{
  const [{createMobileClient},{V1_OPERATIONS}]=await modules;
  let call;let current;
  const api=createMobileClient({baseURL:'https://school.invalid/api/v1',getToken:()=> 'isolated-token',getWallId:()=>1,fetch:async(url,options)=>{
    call={url,options};
    if(current.response==='binary')return new Response(new Uint8Array([0,1,2,255]),{status:200,headers:{...headers,'Content-Type':'application/octet-stream'}});
    if(current.response==='raw-json')return new Response(JSON.stringify({openapi:'3.0.3',paths:{}}),{status:200,headers:{...headers,'Content-Type':'application/json'}});
    return response({operation:current.path});
  }});
  for(const [operationId,spec]of Object.entries(V1_OPERATIONS)) {
    current=spec;
    const params={path:{},query:{}};
    for(const parameter of spec.params) {
      if(parameter.in==='path')params.path[parameter.name]=parameter.type==='integer'?1:'safe-segment';
      if(parameter.in==='query'&&parameter.required)params.query[parameter.name]=parameter.enum?.[0]??(parameter.type==='integer'?1:parameter.type==='boolean'?true:'sample');
    }
    if(spec.body)params.body={};
    const result=await api.operations[operationId](params);
    assert.equal(call.options.method,spec.method,operationId);
    const expectedPath=spec.path.replace(/\{([^}]+)\}/g,(_,name)=>encodeURIComponent(params.path[name]));
    assert.equal(new URL(call.url).pathname,'/api/v1'+expectedPath,operationId);
    assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');
    assert.equal(call.options.headers.Authorization,spec.auth?'Bearer isolated-token':undefined,operationId);
    assert.equal(result.meta.requestId,metadata.requestId);
    if(spec.response==='binary')assert.deepEqual([...new Uint8Array(result.data)],[0,1,2,255]);
    if(spec.response==='raw-json')assert.equal(result.data.openapi,'3.0.3');
  }
});

test('phase3 SDK: generated metadata resolves component and schema references including required bodies', async()=>{
  const [, {V1_OPERATIONS}]=await modules;
  for(const {route,item,method,operation}of ordinaryOperations()) {
    const generated=V1_OPERATIONS[operation.operationId];
    assert.equal(generated.method,method);assert.equal(generated.path,route);
    const expected=new Map();
    for(const raw of [...(item.parameters||[]),...(operation.parameters||[])]) {
      const parameter=resolved(raw);const schema=resolved(parameter.schema)||{};
      expected.set(parameter.in+':'+parameter.name,{name:parameter.name,in:parameter.in,required:!!parameter.required,type:schema.type||'string',...(schema.enum?{enum:schema.enum}:{})});
    }
    assert.deepEqual(generated.params,[...expected.values()],operation.operationId);
    const body=resolved(operation.requestBody);
    assert.equal(generated.bodyRequired,!!body?.required,operation.operationId);
    assert.equal(generated.body,Object.keys(body?.content||{})[0]||null,operation.operationId);
  }
  const download = Object.values(V1_OPERATIONS).find(operation => operation.path === '/admin/db/backups/{name}/download');
  assert.ok(download, 'the actual documented backup download is in the SDK');
  assert.equal(download.response, 'binary');
});

test('phase3 SDK: generation check is deterministic and never rewrites checked outputs',()=>{
  const files=['v1-operations.mjs','v1-operations.d.ts'].map(file=>path.join(root,'sdk',file));
  const before=files.map(file=>({text:fs.readFileSync(file,'utf8'),mtime:fs.statSync(file).mtimeMs}));
  const result=execFileSync(process.execPath,[path.join(root,'sdk/generate-v1-operations.cjs'),'--check'],{cwd:root,encoding:'utf8'});
  assert.equal(JSON.parse(result).publicOperations,143);
  files.forEach((file,index)=>{assert.equal(fs.readFileSync(file,'utf8'),before[index].text);assert.equal(fs.statSync(file).mtimeMs,before[index].mtime);});
});

test('phase3 SDK: binary and raw errors preserve business status code details and correlation',async()=>{
  const [{createMobileClient,ApiError}]=await modules;
  const api=createMobileClient({getToken:()=> 'isolated-token',fetch:async()=>new Response(JSON.stringify({data:null,error:{code:'BANNED',message:'private refusal',details:{scope:'global'}},meta:metadata}),{status:403,headers:{...headers,'Content-Type':'application/json'}})});
  for(const operationId of ['exportOwnData','getOpenApi'])await assert.rejects(api.callOperation(operationId),error=>error instanceof ApiError&&error.status===403&&error.code==='BANNED'&&error.details.scope==='global'&&error.requestId===metadata.requestId);
});

test('phase3 SDK: optional bodies and wall context alternatives do not reject valid server contracts',async()=>{
  const [{createMobileClient},{V1_OPERATIONS}]=await modules;
  const calls=[];const api=createMobileClient({getToken:()=> 'token',getWallId:()=>999,fetch:async(url,options)=>{calls.push({url,options});return response({});}});
  for(const [id,spec]of Object.entries(V1_OPERATIONS))if(spec.body&&!spec.bodyRequired) {
    const params={path:Object.fromEntries(spec.params.filter(p=>p.in==='path').map(p=>[p.name,p.type==='integer'?1:'sample']))};
    await api.callOperation(id,params);
    assert.equal(calls.at(-1).options.body,undefined,id);
  }
  await api.callOperation('getWall',{path:{id:1}});assert.equal(calls.at(-1).options.headers['X-Wall-Id'],undefined);
  await api.callOperation('getPosts',{query:{wall_id:1}});assert.equal(calls.at(-1).options.headers['X-Wall-Id'],undefined);
  await api.callOperation('createPost',{body:{wall_id:1,content:'sample'}});assert.equal(calls.at(-1).options.headers['X-Wall-Id'],undefined);
});
