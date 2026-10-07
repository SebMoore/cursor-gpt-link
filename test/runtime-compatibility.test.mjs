import test from 'node:test';
import assert from 'node:assert/strict';
import {patchConversationActionsRuntime} from '../src/conversation-actions.mjs';
import {patchSubagentSettingsRuntime} from '../src/subagent-settings.mjs';

// Synthetic runtimes exercise both reviewed shapes without shipping Cursor code.
for (const modern of [false, true]) {
  test(`action receiver preserves ${modern ? 'await' : 'yield'} execution and protobuf wiring`, async () => {
    const actionExport=modern?'QFf':'QF', messageExport=modern?'RGk':'RG';
    const source=`
      const actionType=P.${actionExport}.fromBinary, messageType=P.${messageExport}.fromBinary;
      class Runtime {
        ${modern?'async':'async *'} run(e,t,r,n,s,o,i,a,${modern?'c':'l'},z,opts){
          const k={promptSession:{}},v="private",w=t;
          const engine=new Engine(new Holder(k.promptSession),new Inbox);
          ${modern?'await':'yield'} engine.runStream(e,identity(t,v),convert(w,v));
        }
      }
      class Plan {
        async initializeConversation(e,t,r,n,s){const{requestContext:o,provenance:i}=await prepare(t),a=t.planFileContent;
          await this.interactionListener.sendUpdate(e,convert(Events.userMessageAppended(a),n.getPrivacyMode()));
        }
        async handle(){}
      }
    `;
    const patched=patchConversationActionsRuntime(source.replace(/\n\s*/g,''),'chatgpt-codex/');
    const seen=[];
    class Engine {
      constructor(holder,inbox){this.inbox=inbox;this.actionHandlers=new Map([['executePlanAction',{}]]);seen.push(this);}
      async runStream(){return 'completed';}
    }
    const P={
      [actionExport]:{fromBinary:bytes=>({kind:'action',bytes})},
      [messageExport]:{fromBinary:bytes=>({kind:'message',bytes:[...bytes]})}
    };
    const Runtime=new Function('P','Engine','Holder','Inbox','identity','convert',patched+';return Runtime;')(
      P,Engine,class {},class {},value=>value,(value,privacy)=>({value,privacy}));
    const args=[{}, {}, null,null,null,null,{async getBlob(){return new Uint8Array([3]);}},null,null,null,
      {subscriptionActionChannel:'subscription-actions:test',subscriptionPlanPrepends:[[1,2]]}];
    const result=new Runtime().run(...args);
    if(modern)await result;
    else assert.deepEqual(await result.next(),{value:'completed',done:false});
    assert.equal(typeof seen[0].inbox.pop,'function');
    assert.deepEqual(await seen[0].inbox.pop({}),{value:{kind:'action',bytes:new Uint8Array([3])},privacy:'private'});
    assert.deepEqual(seen[0].actionHandlers.get('executePlanAction').__subscriptionPlanPrepends,[{kind:'message',bytes:[1,2]}]);
    // Combined installs register another provider without injecting twice.
    const combined=patchConversationActionsRuntime(patched,'claude-subscription/');
    assert.equal(combined.split('function subscriptionActionReceiver(').length,2);
    assert.match(combined,/"chatgpt-codex\/","claude-subscription\/"/);
  });

  test(`task factory keeps ${modern ? 'nullish' : 'ternary'} provider fallback and parent parameters`, () => {
    const provider=modern?'r=resolveProvider(e)??e.localProvider':'p=resolveProvider(e),r=null!=p?p:e.localProvider';
    const source=`
      function task(e){const t=()=>!1,${provider};return {provider:r,parentRequestedModelName:e.modelId};}
      class Input {read(m){return {modelId:m.modelDetails.modelId,modelInfo:info,localProvider:this.options.localProvider};}}
      function resolve(a,c,m){return{subagentConfig:c,effectiveReadonly:false,resolvedModelId:m,resolvedModelParameters:undefined,subagentIdToResume:undefined};}
    `;
    const patched=patchSubagentSettingsRuntime(source);
    const task=new Function('resolveProvider',patched+';return task;')(e=>e.resolved);
    const parameters=[{id:'reasoning',value:'high'}],fallback={kind:'http'},resolved={kind:'http',endpoints:[]};
    for(const provider of [undefined,resolved]){
      const props=task({modelId:'chatgpt-codex/test',localProvider:fallback,resolved:provider,modelParameters:parameters});
      assert.equal(props.provider,provider??fallback);
      assert.equal(props.parentModelParameters,parameters);
    }
    const ordinary=task({modelId:'ordinary',localProvider:fallback,modelParameters:parameters});
    assert.equal(ordinary.parentModelParameters,undefined);
  });
}
