import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, computed, watch, reactive, nextTick, effectScope } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { createSocialScope, anonymousMessages, mergeMessages, pollMilliseconds, shouldSendMessage, isNearBottom } from '../src/components/chat-social/socialState.js'

const source = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }
async function flush() { await nextTick(); await nextTick(); await nextTick() }
function setup(name, names, overrides = {}) {
  const calls=[],notices=[],mounted=[],cleanup=[],timers=new Map(),events=new Set()
  let nextTimer=0,token='session-a'
  const route=reactive({params:{conversationId:'anonymous-a'},query:{}})
  const wall=reactive({currentWallId:1,canHere:()=>true})
  const user=reactive({sessionRevision:0,user:{id:7},isLoggedIn:true})
  const settings=reactive({prefs:{chat_poll_interval:'20',chat_density:'comfortable',chat_show_timestamps:true,chat_send_shortcut:'enter'}})
  const api=Object.fromEntries(['get','post','put','delete'].map(method=>[method,(...args)=>{const d=deferred();calls.push([method,...args,d]);return d.promise}]))
  const document={visibilityState:'visible',addEventListener:name=>events.add(name),removeEventListener:name=>events.delete(name)}
  const env={
    ref,computed,watch,reactive,nextTick,onMounted:fn=>mounted.push(fn),onBeforeUnmount:fn=>cleanup.push(fn),
    useRoute:()=>route,useRouter:()=>({push:value=>{calls.push(['navigate',value]);return Promise.resolve()}}),useUserStore:()=>user,useWallStore:()=>wall,useSettingsStore:()=>settings,
    useToast:()=>Object.fromEntries(['error','success','info'].map(kind=>[kind,text=>notices.push([kind,text])])),useTimeAgo:()=>({timeAgo:String,fullTime:String}),
    api,getSessionToken:()=>token,getApiErrorMessage:(error,fallback)=>error.response?.data?.error||fallback,
    createSocialScope,anonymousMessages,mergeMessages,pollMilliseconds,isNearBottom,shouldSendMessage,
    setTimeout:(callback,delay)=>{timers.set(++nextTimer,{callback,delay});return nextTimer},clearTimeout:id=>timers.delete(id),
    document,navigator:{clipboard:{writeText:async()=>{}}},...overrides,
  }
  const scope=effectScope()
  const state=scope.run(()=>new Function(...Object.keys(env),parse(source('views/'+name+'.vue')).descriptor.scriptSetup.content.replace(/^import .*$/gm,'')+'\nreturn {'+names.join(',')+'}')(...Object.values(env)))
  return {...state,calls,notices,mounted,cleanup,timers,events,route,wall,user,settings,document,setToken:value=>{token=value},dispose(){cleanup.forEach(fn=>fn());scope.stop()}}
}
const requests=s=>s.calls.filter(call=>['get','post','put','delete'].includes(call[0]))
const last=s=>requests(s).at(-1)
const messages=(rows,more={})=>({data:{messages:rows,is_closed:false,is_initiator:true,can_report:true,...more}})
const row=id=>({id,content:'消息'+id,is_mine:false,created_at:'2026-11-19 20:00:00'})
const summary=(user_id,id,name='同学')=>({user_id,last_message_id:id,last_time:'2026-11-19 20:00:00',other_user:{id:user_id,nickname:name,avatar:'',available:true},last_message:{id,sender_id:7,content:'聊聊课程',is_read:0},unread_count:1,can_send:true})

test('phase2 social SFC scripts and templates compile',()=>{
 for(const path of ['views/Chat.vue','views/TreeHoleChat.vue','views/TreeHoleConversations.vue','components/chat-social/SocialComposer.vue']){
  const {descriptor,errors}=parse(source(path));assert.deepEqual(errors,[],path)
  const script=compileScript(descriptor,{id:path});const result=compileTemplate({source:descriptor.template.content,filename:path,id:path,compilerOptions:{bindingMetadata:script.bindings}})
  assert.deepEqual(result.errors,[],path)
 }
})

test('social scope captures credentials and rejects changed session wall conversation or disposal',()=>{
 let context={token:'a',wallId:2,session:0,conversation:'one'}
 const scope=createSocialScope(()=>context),a=scope.request()
 assert.equal(a.config.headers.Authorization,'Bearer a');assert.equal(a.config.headers['X-Wall-Id'],2);assert.equal(a.current(),true)
 context={...context,wallId:3};assert.equal(a.current(),false)
 const b=scope.request();scope.reset();assert.equal(b.config.signal.aborted,true);assert.equal(b.current(),false)
 const c=scope.request();context={...context,token:'b',session:1};assert.equal(c.current(),false)
 const d=scope.request();context={...context,conversation:'two'};assert.equal(d.current(),false)
 const e=scope.request();scope.dispose();assert.equal(e.current(),false);assert.equal(e.config.signal.aborted,true)
})

test('anonymous normalization never retains identity or reply metadata',()=>{
 const [safe]=anonymousMessages([{...row(1),sender_id:44,receiver_id:7,sender_nickname:'secret',other_user_id:44,reply_to_content:'secret quote',is_mine:1}])
 assert.deepEqual(Object.keys(safe).sort(),['content','created_at','id','is_mine','is_read','is_revoked'].sort())
 assert.equal(safe.is_mine,true);assert.deepEqual(anonymousMessages([null,{id:-1},{id:'invalid'}]),[])
 assert.deepEqual(mergeMessages([row(1),row(3)],[{...row(3),is_revoked:true},row(2)]).map(m=>[m.id,!!m.is_revoked]),[[1,false],[2,false],[3,true]])
})

test('send shortcuts preserve mobile newlines shift newlines and IME composition',()=>{
 const enter={key:'Enter'}
 assert.equal(shouldSendMessage(enter,'enter',false),true)
 assert.equal(shouldSendMessage(enter,'enter',true),false)
 assert.equal(shouldSendMessage({...enter,shiftKey:true},'enter'),false)
 assert.equal(shouldSendMessage({...enter,isComposing:true},'enter'),false)
 assert.equal(shouldSendMessage({...enter,keyCode:229},'enter'),false)
 assert.equal(shouldSendMessage(enter,'modifier'),false)
 assert.equal(shouldSendMessage({...enter,ctrlKey:true},'modifier'),true)
 assert.equal(shouldSendMessage({...enter,metaKey:true},'modifier',true),true)
 assert.equal(pollMilliseconds('60'),60000);assert.equal(pollMilliseconds('bad'),20000)
 assert.equal(isNearBottom({scrollHeight:1000,scrollTop:100,clientHeight:200}),false)
})

test('recent conversations apply before cursor search read status and opened ordering',async()=>{
 const s=setup('Chat',['loadConversations','conversations','visibleConversations','query','cursor','hasMore','conversationSort','openedAt','deliveryStatus','lastMessageText'])
 const a=s.loadConversations();last(s).at(-1).resolve({data:{conversations:[summary(8,100,'小林'),summary(9,90,'阿青')],hasMore:true,next_before_id:90}});await a
 const b=s.loadConversations(true);assert.equal(last(s)[2].params.before,90)
 last(s).at(-1).resolve({data:{conversations:[summary(10,80,'新同学')],hasMore:false,next_before_id:null}});await b
 assert.equal(s.conversations.value.length,3);assert.equal(s.hasMore.value,false)
 s.query.value='课程';assert.equal(s.visibleConversations.value.length,3)
 s.query.value='阿青';assert.deepEqual(s.visibleConversations.value.map(c=>c.user_id),[9])
 s.query.value='';s.openedAt.value={10:300,8:100};s.conversationSort.value='opened';assert.equal(s.visibleConversations.value[0].user_id,10)
 assert.equal(s.deliveryStatus(summary(8,100)),'未读');assert.equal(s.deliveryStatus({...summary(8,100),last_message:{sender_id:7,is_read:1}}),'已读')
 assert.equal(s.lastMessageText({...summary(8,100),last_message:{is_revoked:1,content:'secret'}}),'消息已撤回')
 s.dispose()
})

test('recent summaries ignore old requests after refresh and wall switch',async()=>{
 const s=setup('Chat',['loadConversations','conversations'])
 const a=s.loadConversations();const first=last(s)
 const b=s.loadConversations();const second=last(s)
 second.at(-1).resolve({data:{conversations:[summary(9,20)]}});await b
 first.at(-1).resolve({data:{conversations:[summary(8,10)]}});await a
 assert.equal(s.conversations.value[0].user_id,9)
 const c=s.loadConversations();const third=last(s);s.wall.currentWallId=2;await flush()
 third.at(-1).resolve({data:{conversations:[summary(44,30)]}});await c
 assert.equal(s.conversations.value.length,0);s.dispose()
})

test('social poll interval is reactive and unmount clears listener and timers',async()=>{
 const s=setup('Chat',['startPolling'])
 s.startPolling();assert.equal([...s.timers.values()][0].delay,20000)
 s.settings.prefs.chat_poll_interval='60';await flush();assert.equal([...s.timers.values()][0].delay,60000)
 s.dispose();assert.equal(s.timers.size,0);assert.equal(s.events.size,0)
})

test('anonymous refresh merges newest page and preserves history scroll position',async()=>{
 const s=setup('TreeHoleChat',['loadMessages','chatMessages','messagesArea','unseenCount','loading','hasMoreHistory','historyCursor'])
 const a=s.loadMessages();last(s).at(-1).resolve(messages([row(100)],{hasMore:true,next_before_id:100}));await a
 const area={scrollTop:200,scrollHeight:1000,clientHeight:200};s.messagesArea.value=area
 const b=s.loadMessages(true);last(s).at(-1).resolve(messages([row(100),row(101)]));await b
 assert.deepEqual(s.chatMessages.value.map(m=>m.id),[100,101]);assert.equal(area.scrollTop,200);assert.equal(s.unseenCount.value,1)
 assert.equal(s.hasMoreHistory.value,true);assert.equal(s.historyCursor.value,100);s.dispose()
})

test('anonymous prepend uses older cursor and anchors the visible history',async()=>{
 const s=setup('TreeHoleChat',['loadOlderMessages','chatMessages','messagesArea','loading','hasMoreHistory','historyCursor'])
 s.loading.value=false;s.chatMessages.value=[row(100)];s.hasMoreHistory.value=true;s.historyCursor.value=100
 const area={scrollTop:15,clientHeight:50,get scrollHeight(){return s.chatMessages.value.length*100}}
 s.messagesArea.value=area
 const a=s.loadOlderMessages();assert.equal(last(s)[2].params.before,100)
 last(s).at(-1).resolve(messages([row(90),row(99)],{hasMore:false}));await a
 assert.deepEqual(s.chatMessages.value.map(m=>m.id),[90,99,100]);assert.equal(area.scrollTop,215);assert.equal(s.hasMoreHistory.value,false);s.dispose()
})

test('anonymous refresh fills gaps when more than one page arrives between polls',async()=>{
 const s=setup('TreeHoleChat',['loadMessages','chatMessages','loading'])
 s.chatMessages.value=[row(50)];s.loading.value=false
 const a=s.loadMessages(true);last(s).at(-1).resolve(messages([row(101),row(102)],{hasMore:true,next_before_id:101}));await flush()
 assert.equal(last(s)[2].params.before,101)
 last(s).at(-1).resolve(messages([row(50),row(100)],{hasMore:false}));await a
 assert.deepEqual(s.chatMessages.value.map(m=>m.id),[50,100,101,102]);s.dispose()
})

test('anonymous sends are single flight preserve newer drafts and never include peer identity or quotes',async()=>{
 const s=setup('TreeHoleChat',['sendMessage','newMessage','loading','chatMessages'])
 s.loading.value=false;s.newMessage.value='先发这一句'
 const a=s.sendMessage(),b=s.sendMessage();assert.equal(requests(s).length,1);const post=last(s)
 assert.deepEqual(post[2],{content:'先发这一句'});assert.equal(post[3].headers['X-Wall-Id'],1)
 s.newMessage.value='发送期间的新草稿';post.at(-1).resolve({data:{message:'已发送'}});await flush()
 last(s).at(-1).resolve(messages([row(1)]));await a;await b
 assert.equal(s.newMessage.value,'发送期间的新草稿');s.dispose()
})

test('anonymous report uses conversation capability and selected message ids only',async()=>{
 const s=setup('TreeHoleChat',['doReport','canReport','reportReason','chatMessages'])
 s.canReport.value=false;s.reportReason.value='不当发言';await s.doReport();assert.equal(requests(s).length,0)
 s.canReport.value=true;s.chatMessages.value=[{...row(1),is_mine:false},{...row(2),is_mine:true}]
 const a=s.doReport();assert.deepEqual(last(s)[2],{conversation_id:'anonymous-a',reason:'不当发言',selected_message_ids:[1]})
 last(s).at(-1).resolve({data:{}});await a;s.dispose()
})

test('anonymous close response cannot close a newly opened conversation',async()=>{
 const s=setup('TreeHoleChat',['closeConversation','isClosed','loading'])
 s.loading.value=false;const a=s.closeConversation();const first=last(s)
 s.route.params.conversationId='anonymous-b';await flush()
 first.at(-1).resolve({data:{}});await a
 assert.equal(s.isClosed.value,false);s.dispose()
})

test('anonymous explicit copy has a manual fallback and revoked content cannot be copied',async()=>{
 let copies=0
 const s=setup('TreeHoleChat',['copyMessage','copyFallback','operationStatus'],{navigator:{clipboard:{writeText:async()=>{copies++;throw new Error('denied')}}}})
 await s.copyMessage({...row(1),content:'仅复制内容'});assert.equal(copies,1);assert.equal(s.copyFallback.value,'仅复制内容');assert.match(s.operationStatus.value,/选中文本/)
 await s.copyMessage({...row(2),is_revoked:true,content:'secret'});assert.equal(copies,1);s.dispose()
})

test('anonymous initial response after unmount cannot restart polling',async()=>{
 const s=setup('TreeHoleChat',[])
 const initial=s.mounted[0]();const request=last(s);s.dispose();request.at(-1).resolve(messages([]));await initial
 assert.equal(s.timers.size,0);assert.equal(s.events.size,0)
})

test('anonymous list partial deletion preserves only failed ids and stale response is fenced',async()=>{
 const s=setup('TreeHoleConversations',['deleteSelected','selectedIds','myConversations'])
 s.selectedIds.value=new Set(['good','bad']);s.myConversations.value=[{conversation_id:'good'},{conversation_id:'bad'}]
 const a=s.deleteSelected();const batch=requests(s);batch[0].at(-1).resolve({data:{}});batch[1].at(-1).reject(new Error('network'));await a
 assert.deepEqual([...s.selectedIds.value],['bad']);assert.deepEqual(s.myConversations.value.map(c=>c.conversation_id),['bad']);s.dispose()
})

test('anonymous list ignores an old wall response and clears selection on context change',async()=>{
 const s=setup('TreeHoleConversations',['loadConversations','myConversations','selectedIds','selectMode'])
 const a=s.loadConversations();const first=last(s);s.selectedIds.value=new Set(['old']);s.selectMode.value=true
 s.wall.currentWallId=2;await flush();const second=last(s)
 second.at(-1).resolve({data:{my:[{conversation_id:'new'}],pending:[]}});await flush()
 first.at(-1).resolve({data:{my:[{conversation_id:'old'}],pending:[]}});await a
 assert.equal(s.myConversations.value[0].conversation_id,'new');assert.equal(s.selectedIds.value.size,0);assert.equal(s.selectMode.value,false);s.dispose()
})

test('anonymous authorization loss clears loaded content copying and report capability',async()=>{
 const s=setup('TreeHoleChat',['loadMessages','chatMessages','canReport','copyFallback','isClosed','hasMoreHistory'])
 s.chatMessages.value=[row(1)];s.canReport.value=true;s.copyFallback.value='旧消息';s.hasMoreHistory.value=true
 const a=s.loadMessages(true);last(s).at(-1).reject({response:{status:403,data:{error:'无权访问'}}});await a
 assert.deepEqual(s.chatMessages.value,[]);assert.equal(s.copyFallback.value,'');assert.equal(s.canReport.value,false);assert.equal(s.isClosed.value,true);assert.equal(s.hasMoreHistory.value,false);s.dispose()
})

test('anonymous polling refreshes revocation metadata in loaded older history',async()=>{
 const s=setup('TreeHoleChat',['loadMessages','chatMessages','loading'])
 s.loading.value=false;s.chatMessages.value=[row(1),row(50),row(100)]
 const a=s.loadMessages(true);last(s).at(-1).resolve(messages([row(100)],{hasMore:true,next_before_id:100}));await flush()
 last(s).at(-1).resolve(messages([{...row(1),content:'[消息已撤回]',is_revoked:1},row(50)],{hasMore:false}));await a
 assert.equal(s.chatMessages.value[0].is_revoked,true);assert.equal(s.chatMessages.value[0].content,'[消息已撤回]');s.dispose()
})

