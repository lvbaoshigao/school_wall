'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { getRateUserId, getRequestAuth } = require('../lib/requestAuth');
const secret = 'phase3-request-cache-isolated-test-secret';

function fixture() {
  const users = new Map([[1, { id:1, role:'user', status:'active', token_version:0 }], [2, { id:2, role:'user', status:'active', token_version:0 }]]);
  let reads = 0;
  const db = { prepare(sql) {
    assert.match(sql, /FROM users WHERE id = \?/);
    return { get(id) { reads++; return users.has(id) ? { ...users.get(id) } : undefined; } };
  } };
  const token = (id=1, claims={}) => jwt.sign({ id, tv:0, ...claims }, secret, { expiresIn:'1h' });
  return { db, users, token, req: { headers:{authorization:'Bearer '+token()} }, reads:()=>reads };
}

test('phase3 auth cache: synchronous limiter calls and first authentication share one user lookup and signature', () => {
  const f = fixture();
  const originalVerify = jwt.verify;
  let verifications = 0;
  jwt.verify = function (...args) { verifications++; return originalVerify.apply(this, args); };
  try {
    assert.equal(getRateUserId(f.req,f.db,secret),1);
    assert.equal(getRateUserId(f.req,f.db,secret),1);
    assert.equal(getRateUserId(f.req,f.db,secret),1);
    const auth = getRequestAuth(f.req,f.db,secret);
    assert.equal(auth.user.id,1);
    assert.equal(f.reads(),1);
    assert.equal(verifications,1);
    auth.claims.id=2; auth.user.role='super_admin';
    const again=getRequestAuth(f.req,f.db,secret);
    assert.equal(again.claims.id,1); assert.equal(again.user.role,'user');
    assert.equal(f.reads(),2); assert.equal(verifications,1);
  } finally { jwt.verify=originalVerify; }
});

test('phase3 auth cache: every subsequent auth checks current role status and token version', () => {
  const f=fixture();
  getRateUserId(f.req,f.db,secret);getRequestAuth(f.req,f.db,secret);
  f.users.get(1).role='admin'; assert.equal(getRequestAuth(f.req,f.db,secret).user.role,'admin');
  f.users.get(1).status='banned'; assert.equal(getRequestAuth(f.req,f.db,secret).user.status,'banned');
  f.users.get(1).token_version=1; assert.equal(getRequestAuth(f.req,f.db,secret).user.token_version,1);
  f.users.delete(1); assert.equal(getRequestAuth(f.req,f.db,secret).user,undefined);
});

test('phase3 auth cache: a limiter snapshot never survives repeated asynchronous boundaries', async () => {
  const f=fixture();
  assert.equal(getRateUserId(f.req,f.db,secret),1); await Promise.resolve();
  assert.equal(getRateUserId(f.req,f.db,secret),1); await Promise.resolve();
  f.users.get(1).token_version=1;
  assert.equal(getRateUserId(f.req,f.db,secret),null);
  const auth=getRequestAuth(f.req,f.db,secret);
  assert.equal(auth.user.token_version,1);
  assert.equal(f.reads(),3);
});

test('phase3 auth cache: expiry and not-before remain live after signature reuse', async () => {
  const f=fixture(); const realNow=Date.now;
  const now=Math.floor(realNow()/1000); const expires=jwt.sign({ id:1,tv:0,exp:now+20,nbf:now-2 },secret);
  f.req.headers.authorization='Bearer '+expires;
  try {
    assert.equal(getRateUserId(f.req,f.db,secret),1);
    await Promise.resolve();
    Date.now=()=> (now+21)*1000;
    assert.equal(getRateUserId(f.req,f.db,secret),null);
    assert.equal(getRequestAuth(f.req,f.db,secret).claims,null);
    Date.now=()=> (now-3)*1000;
    assert.equal(getRequestAuth(f.req,f.db,secret).claims,null);
  } finally { Date.now=realNow; }
});

test('phase3 auth cache: header secret database and request identities isolate cached authorization', () => {
  const f=fixture(); assert.equal(getRateUserId(f.req,f.db,secret),1);
  assert.equal(getRateUserId(f.req,f.db,secret+'-different'),null);
  assert.equal(getRateUserId(f.req,f.db,secret),1);
  f.req.headers.authorization='Bearer '+f.token(2);assert.equal(getRateUserId(f.req,f.db,secret),2);
  const second=fixture();second.users.get(2).status='banned';assert.equal(getRateUserId(f.req,second.db,secret),null);
  f.users.get(2).status='banned';const other={headers:{...f.req.headers}};assert.equal(getRateUserId(other,f.db,secret),null);
});

test('phase3 auth cache: invalid dashboard revoked or missing accounts cannot create user quota', () => {
  for (const claims of [{ id:1,tv:1 },{id:999,tv:0},{id:1,tv:0,aud:'dashboard'},{id:1,tv:-1}]) {
    const f=fixture();f.req.headers.authorization='Bearer '+jwt.sign(claims,secret,{expiresIn:'1h'});
    assert.equal(getRateUserId(f.req,f.db,secret),null);
  }
  const f=fixture();f.db.prepare=()=>{throw Error('unavailable')};assert.equal(getRateUserId(f.req,f.db,secret),null);
  for(const authorization of [undefined,[],123,'Bearer bad-token'])assert.equal(getRateUserId({headers:{authorization}},f.db,secret),null);
});
