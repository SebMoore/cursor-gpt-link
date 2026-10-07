import assert from 'node:assert/strict';
import {createSubscriptionActionChannel,subscriptionActionReceiver} from '../src/conversation-actions.mjs';

function classBody(source,start){
  let depth=0,quote;
  for(let i=source.indexOf('{',start);i<source.length;i++){
    const ch=source[i];
    if(quote){if(ch==='\\')i++;else if(ch===quote)quote=undefined;continue;}
    if(ch==='"'||ch==="'"){quote=ch;continue;}
    if(ch==='{')depth++;
    if(ch==='}'&&!--depth)return source.slice(start,i+1);
  }
  throw Error('Native manager class end missing');
}
// Only the transport is a fixture; manager lifecycle and delivery methods are
// extracted from the installed build, without shipping Cursor source code.
function stream(){
  const queue=[];let closed=false,wake;
  return {async write(value){if(closed)throw Error('closed stream');queue.push(value);wake?.();},
    close(){closed=true;wake?.();},throw(){closed=true;wake?.();},
    async *[Symbol.asyncIterator](){while(!closed||queue.length){if(queue.length)yield queue.shift();else await new Promise(resolve=>{wake=resolve;});}}};
}
class Message{constructor(value){Object.assign(this,value);}toBinary(){return new TextEncoder().encode(JSON.stringify(this));}}

export async function verifyConversationActionsWorkbench(source,prefixes){
  const start=source.indexOf('class{constructor(){this.abortCallbacks=[]');
  assert.ok(start>=0,'Native action manager found');
  const body=classBody(source,start),dependencies={};
  dependencies[body.match(/this.clientStream=([\w$]+)\(\)/)[1]]=stream;
  dependencies[body.match(/new ([\w$]+)\("ControlledConversationActionManager/)[1]]=Error;
  dependencies[body.match(/([\w$]+)\.error\([\w$]+,"Error writing conversation action"/)[1]]={error(){}};
  for(const match of body.matchAll(/new ([\w$]+)\(\{/g))dependencies[match[1]]=Message;
  const NativeManager=new Function(...Object.keys(dependencies),'return '+body)(...Object.values(dependencies));
  const manager=new NativeManager(),controller=new AbortController(),ctx={signal:controller.signal};
  manager.addAbortCallback(()=>controller.abort());
  const prepared=[],channel=createSubscriptionActionChannel(manager,ctx,async a=>prepared.push(a));
  const receiver=subscriptionActionReceiver({async getBlob(ctx,key){return (await channel.read(key)).bytes;}},channel.key,bytes=>JSON.parse(new TextDecoder().decode(bytes)),{});
  try{
    const queued=new Message({action:{case:'userMessageAction',value:{userMessage:{messageId:'queued',text:'Also port online status',selectedContext:{images:['attachment']}}}}});
    await manager.submitConversationAction(queued);
    assert.equal(manager.hasUnprocessedMessages(),true,'Transport acceptance is not model acknowledgement');
    assert.equal((await receiver.peek(ctx)).action.value.userMessage.text,'Also port online status');
    await channel.seal();channel.reopen();await channel.settle();
    assert.equal(channel.queue.length,1,'Native replay is deduplicated');
    assert.deepEqual((await receiver.pop(ctx)).action,queued.action);
    manager.markMessageAsProcessed(queued.action.value.userMessage);
    assert.equal(manager.hasUnprocessedMessages(),false);
    assert.equal(await receiver.peek(ctx),undefined);
    manager.abort('Stop');
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(ctx.signal.aborted,'Native Stop callback still reaches the runtime');
  }finally{channel.dispose();}
  const registry=JSON.parse(source.match(/var __subscriptionActionPrefixes=(\[[^;]+\]);/)[1]);
  for(const prefix of prefixes)assert.ok(registry.includes(prefix));
  assert.match(source,/return this.runLocalAgentInExtensionHost\([^)]*,a\)\}return this.client.run/);
  assert.match(source,/subscriptionPlanPrepends:[\w$]+\.action.case==="executePlanAction"\?[\w$]+\.map\(message=>Array.from\(message.toBinary\(\)\)\)/);
  assert.match(source,/subscriptionActionChannel:[\w$]+\.subscriptionActionChannel,subscriptionPlanPrepends:[\w$]+\.subscriptionPlanPrepends,serializeSubagentStatesAsBlobRefs:/);
  console.log('Native action manager: queued delivery, Build forwarding, replay, acknowledgement and Stop passed.');
}

export function verifyConversationActionsRuntime(source){
  assert.match(source,/subscriptionActionReceiver\(i,[\w$]+\.subscriptionActionChannel,bytes=>[\w$]+\([\w$]+\.QFf?\.fromBinary\(bytes\),[\w$]+\),new [\w$]+\)/);
  assert.match(source,/actionHandlers.get\("executePlanAction"\).__subscriptionPlanPrepends=[\w$]+\.subscriptionActionChannel\?/);
  // 3.21.1 rotated the minified locals of the plan initializer.
  const insertion=source.search(/await prependSubscriptionPlanMessages\(this\.__subscriptionPlanPrepends,e,[\w$]+,[\w$]+,this\.config,this\.resourceAccessor,/);
  assert.ok(insertion>=0);
  const kickoff=source.indexOf('t.kickoffMessageId??crypto.randomUUID()',insertion);
  const handle=source.indexOf('async handle(',insertion);
  assert.ok(kickoff>insertion&&kickoff<handle,'Unconfirmed human turns are recorded before native plan kickoff');
  assert.match(source,/\.\.\.[\w$]+\.runOptions,requestedModel:/,'DTO retains the action channel and plan prepends');
  console.log('Runtime action receiver and native plan initializer wiring passed.');
}
