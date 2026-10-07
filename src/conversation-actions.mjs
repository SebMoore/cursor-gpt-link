export function subscriptionActionModel(model, prefixes) {
  return typeof model === 'string' && prefixes.some(prefix => model.startsWith(prefix));
}

// Use the existing binary callback transport. The per-run key is not a blob
// hash, is never persisted, and only this run's receiver can request it.
export function createSubscriptionActionChannel(manager, ctx, prepare) {
  const key='subscription-actions:'+crypto.randomUUID();
  const queue=[];
  const barriers=new WeakMap(),seen=new Set();
  let closed=false, failure, pump;
  const start=()=>{
    pump=manager.run(ctx,{write:async action=>{
      const barrier=barriers.get(action);if(barrier){barrier();return;}
      ctx.signal?.throwIfAborted();
      const id=action.action.case==='userMessageAction'?action.action.value.userMessage?.messageId:undefined;
      if(id&&seen.has(id))return;
      try {await prepare(action);ctx.signal?.throwIfAborted();queue.push(action);if(id)seen.add(id);}
      catch(error){failure=error;throw error;}
    }});
    Promise.resolve(pump).catch(error=>{failure=error;});
  };
  start();
  const settle=async()=>{
    ctx.signal?.throwIfAborted();
    if(closed)await pump;
    else {
      const barrier={action:{case:'subscriptionLocalBarrier'}};
      const reached=new Promise(resolve=>barriers.set(barrier,resolve));
      await manager.submitConversationAction(barrier);
      await Promise.race([reached,Promise.resolve(pump)]);
    }
    if(failure)throw failure;ctx.signal?.throwIfAborted();
  };
  const close=()=>{if(!closed){closed=true;manager.close();}};
  const abort=()=>{queue.length=0;close();};
  ctx.signal?.addEventListener('abort',abort,{once:true});
  if(ctx.signal?.aborted)abort();
  return {key,queue,settle,close,
    async seal(){close();await pump;if(failure)throw failure;ctx.signal?.throwIfAborted();},
    reopen(){if(closed){closed=false;manager.reopen();start();}},
    async read(bytes){
      const command=new TextDecoder().decode(bytes);
      if(command!==key+':peek'&&command!==key+':pop')return undefined;
      await settle();
      const action=command.endsWith(':pop')?queue.shift():queue[0];
      return {bytes:action?.toBinary()??new Uint8Array()};
    },
    dispose(){close();ctx.signal?.removeEventListener('abort',abort);}
  };
}

export async function runSubscriptionActions(service, args, prefixes, prepare) {
  const [ctx,initialState,initialAction,model,listener,blobs,checkpoints,mcp,resources,options,manager]=args;
  const id=options.requestedModel?.modelId??model?.modelId;
  if(!manager||!subscriptionActionModel(id,prefixes))return service._subscriptionNativeLocalAgent(...args);
  const channel=createSubscriptionActionChannel(manager,ctx,action=>prepare({ctx,action,resources,blobStore:blobs,options,source:'queued_action'}));
  let latestState=initialState;
  const blobProxy=new Proxy(blobs,{get(target,key){
    if(key==='getBlob')return async(context,bytes)=>{
      const result=await channel.read(bytes);
      return result?result.bytes:target.getBlob(context,bytes);
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const checkpointProxy=new Proxy(checkpoints,{get(target,key){
    if(key==='handleCheckpoint')return async(context,state,...rest)=>{await target.handleCheckpoint(context,state,...rest);latestState=state;};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const listenerProxy=new Proxy(listener,{get(target,key){
    if(key==='sendUpdate')return async(context,update)=>{
      if(update.message.case==='turnEnded'){
        await channel.seal();
        // A follow-up can arrive between the engine's final peek and this event.
        if(channel.queue.length){channel.reopen();return;}
      }
      return target.sendUpdate(context,update);
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  try {
    let action=initialAction,first=true;
    for(;;){
      ctx.signal?.throwIfAborted();
      await service._subscriptionNativeLocalAgent(ctx,latestState,action,model,listenerProxy,blobProxy,checkpointProxy,mcp,resources,
        {...options,subscriptionActionChannel:channel.key,subscriptionPlanPrepends:first?options.subscriptionPlanPrepends:undefined});
      await channel.settle();
      if(!channel.queue.length)return;
      action=channel.queue.shift();first=false;
    }
  } finally {channel.dispose();}
}

export function subscriptionActionReceiver(blobStore, key, decode, fallback) {
  if(typeof key!=='string'||!key.startsWith('subscription-actions:'))return fallback;
  let cached,loading;
  return {
    async peek(ctx){
      ctx.signal?.throwIfAborted();
      if(cached)return cached;
      if(!loading)loading=blobStore.getBlob(ctx,new TextEncoder().encode(key+':peek')).then(bytes=>{
        cached=bytes?.length?decode(bytes):undefined;return cached;
      }).finally(()=>{loading=undefined;});
      return loading;
    },
    async pop(ctx){
      ctx.signal?.throwIfAborted();
      if(loading)await loading;
      const bytes=await blobStore.getBlob(ctx,new TextEncoder().encode(key+':pop'));
      cached=undefined;
      return bytes?.length?decode(bytes):undefined;
    }
  };
}

// These are existing human messages that have not reached a checkpoint yet.
// Record them through the native state handler before the plan's kickoff turn.
export async function prependSubscriptionPlanMessages(messages, ctx, state, requestContext, config, resources, notify) {
  if(!messages?.length)return;
  const ids=new Set(messages.map(message=>message.messageId).filter(Boolean));
  const existing=await state.findUserTurnMessageIds(ctx,{messageIds:ids});
  for(const message of messages){
    ctx.signal?.throwIfAborted();
    if(message.messageId&&existing.has(message.messageId))continue;
    await state.createAgentTurn(ctx,message,requestContext,config,resources);
    await notify(message);
    if(message.messageId)existing.add(message.messageId);
  }
}

function once(source,before,after){
  if(source.split(before).length!==2)throw new Error('Conversation actions anchor is not unique: '+before.slice(0,100));
  return source.replace(before,after);
}
function registry(source,prefix){
  const pattern=/var __subscriptionActionPrefixes=(\[[^;]+\]);/;
  const found=source.match(pattern);
  return found?source.replace(pattern,'var __subscriptionActionPrefixes='+JSON.stringify([...new Set([...JSON.parse(found[1]),prefix])])+';'):undefined;
}
export function patchConversationActionsWorkbench(source,surface,prefix){
  const combined=registry(source,prefix);if(combined)return combined;
  if(!['desktop','glass'].includes(surface))throw new Error('Unknown workbench surface');
  const local=source.match(/async runLocalAgentInExtensionHost\(([^)]+)\)\{/);
  if(!local)throw new Error('Local agent entry point missing');
  const prepare=[...source.matchAll(/await ([\w$]+)\(\{ctx:[\w$]+,action:[\w$]+,resources:[\w$]+,blobStore:[\w$]+,options:[\w$]+,source:"queued_action"\}\)/g)];
  if(prepare.length!==1)throw new Error('Native action preparation function missing');
  source=once(source,local[0],`async runLocalAgentInExtensionHost(...args){return runSubscriptionActions(this,args,__subscriptionActionPrefixes,${prepare[0][1]})}async _subscriptionNativeLocalAgent(${local[1]}){`);
  const call=source.match(/return this.runLocalAgentInExtensionHost\(([^)]+)\)\}return this.client.run/);
  if(!call)throw new Error('Local action manager forwarding anchor missing');
  source=once(source,call[0],call[0].replace(call[1]+')',call[1]+',a)'));
  const options=local[1].split(',').at(-1);
  source=once(source,'serializeSubagentStatesAsBlobRefs:this.experimentService.checkFeatureGate(',
    `subscriptionActionChannel:${options}.subscriptionActionChannel,subscriptionPlanPrepends:${options}.subscriptionPlanPrepends,serializeSubagentStatesAsBlobRefs:this.experimentService.checkFeatureGate(`);
  // The executePlan override otherwise discards collectUnconfirmedHumanMessages.
  const action=source.match(/([\w$]+)=([\w$]+)\.conversationActionOverride\?\?new [\w$]+\(\{action:\{case:"userMessageAction",value:new [\w$]+\(\{userMessage:[\w$]+,requestContext:[\w$]+,prependUserMessages:([\w$]+),/);
  if(!action)throw new Error('Plan action override anchor missing');
  const optionsAnchor=source.indexOf('subagentModelOverrides:',action.index);
  const optionsEnd=source.indexOf(',',optionsAnchor);
  if(optionsAnchor<0||optionsEnd<optionsAnchor)throw new Error('Plan run options missing');
  source=source.slice(0,optionsEnd)+`,subscriptionPlanPrepends:${action[1]}.action.case==="executePlanAction"?${action[3]}.map(message=>Array.from(message.toBinary())):undefined`+source.slice(optionsEnd);
  return 'var __subscriptionActionPrefixes='+JSON.stringify([prefix])+';\n'+
    [subscriptionActionModel,createSubscriptionActionChannel,runSubscriptionActions].map(fn=>fn.toString()).join('\n')+'\n'+source;
}

export function patchConversationActionsRuntime(source,prefix){
  const combined=registry(source,prefix);if(combined)return combined;
  // Read locals from either runtime. 3.23.23 awaits the engine instead of
  // yielding it, and renames the QF/RG protobuf exports to QFf/RGk.
  const engines=[...source.matchAll(/new [\w$]+\([\w$]+\.promptSession\),new ([\w$]+)\);(?:yield|await) ([\w$]+)\.runStream\(e,[\w$]+\([\w$]+,([\w$]+)\),([\w$]+)\(([\w$]+),\3\)/g)];
  if(engines.length!==1)throw new Error('Local engine receiver anchor is not unique');
  const [receiver,inbox,engine,privacy,convert]=engines[0];
  const engineStart=engines[0].index;
  const moduleStart=source.lastIndexOf('class ',engineStart);
  const runHeader=source.slice(moduleStart,engineStart).match(/run\(e,t,[\w$]+,[\w$]+,[\w$]+,[\w$]+,i,a,[\w$]+,([\w$]+),([\w$]+)\)/);
  if(!runHeader)throw new Error('Local engine run options missing');
  const opts=runHeader[2];
  // Resolve the protobuf namespace from this module instead of assuming the
  // entry-point namespace or the symbols used by the other runtime bundle.
  const planMessages=new Map([...source.matchAll(/([\w$]+)\.(RGk?)[.(]/g)].map(m=>[m[1],m[2]]));
  const namespaces=[...source.matchAll(/([\w$]+)\.(QFf?)[.(]/g)].filter(m=>planMessages.has(m[1]));
  if(!namespaces.length)throw new Error('Conversation action protobuf namespace missing');
  const namespace=namespaces.reduce((best,m)=>Math.abs(m.index-engineStart)<Math.abs(best.index-engineStart)?m:best),ns=namespace[1];
  const replacement=receiver.replace('new '+inbox,`subscriptionActionReceiver(i,${opts}.subscriptionActionChannel,bytes=>${convert}(${ns}.${namespace[2]}.fromBinary(bytes),${privacy}),new ${inbox})`)
    .replace(/;(yield|await) /,(_,keyword)=>`;${engine}.actionHandlers.get("executePlanAction").__subscriptionPlanPrepends=${opts}.subscriptionActionChannel?${opts}.subscriptionPlanPrepends?.map(bytes=>${ns}.${planMessages.get(ns)}.fromBinary(Uint8Array.from(bytes))):undefined;${keyword} `);
  source=once(source,receiver,replacement);
  // Locate the plan initializer by its unique file-content resolution.
  const pattern=/async initializeConversation\(e,t,[\w$]+,([\w$]+),[\w$]+\)\{const\{requestContext:([\w$]+),provenance:[\w$]+\}=await [\w$]+\(([^;]+?)\),([\w$]+)=t\.planFileContent/;
  const plan=source.match(pattern);if(!plan)throw new Error('Plan initializer missing');
  const state=plan[1],requestContext=plan[2],planContent=plan[4];
  const planSection=source.slice(plan.index,source.indexOf('async handle(',plan.index));
  const notify=planSection.match(new RegExp('await this\\.interactionListener\\.sendUpdate\\(e,([\\w$]+)\\(([\\w$]+)\\.userMessageAppended\\([\\w$]+\\),'+state+'\\.getPrivacyMode\\(\\)\\)\\)'));
  if(!notify)throw new Error('Native plan message notification missing');
  const first=plan[0].replace(','+planContent+'=t.planFileContent',';await prependSubscriptionPlanMessages(this.__subscriptionPlanPrepends,e,'+state+','+requestContext+',this.config,this.resourceAccessor,message=>this.interactionListener.sendUpdate(e,'+notify[1]+'('+notify[2]+'.userMessageAppended(message),'+state+'.getPrivacyMode())));const '+planContent+'=t.planFileContent');
  source=once(source,plan[0],first);
  return 'var __subscriptionActionPrefixes='+JSON.stringify([prefix])+';\n'+
    [subscriptionActionReceiver,prependSubscriptionPlanMessages].map(fn=>fn.toString()).join('\n')+'\n'+source;
}
