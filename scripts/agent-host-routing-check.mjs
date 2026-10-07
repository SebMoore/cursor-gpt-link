import assert from 'node:assert/strict';

// Execute the actual strategy initialization and AgentClientService adapter
// from a generated workbench, including the case where Agent Host is enabled.
export async function verifyAgentHostRouting(source) {
  const helper = source.match(/function __chatgptRouteExecutionStrategy\(host, local\) \{[\s\S]*?\n\}\n/);
  assert.ok(helper, 'Agent Host routing helper present');
  const predicate = source.match(/function __isChatgptBridgeModel\(m\)\{[^}]+\}/);
  assert.ok(predicate, 'Subscription model predicate present');
  const init = source.match(/this\._executionStrategy=__chatgptRouteExecutionStrategy\(([et])\?\.executionStrategy,new ([\w$]+)\(this\.agentClientService\)\)/);
  assert.ok(init, 'AgentCompatService uses selective routing');
  const adapter = source.match(new RegExp(init[2].replace(/\$/g, '\\$') + '=class\\{constructor\\(([et])\\)\\{this.agentClientService=\\1\\}executeTurn\\(([et])\\)\\{return this.agentClientService.run\\([^}]+\\)\\}\\}'));
  assert.ok(adapter, 'Native local execution adapter present');
  const calls = [];
  let disposed = 0;
  const host = {executeTurn: turn => { calls.push(['host', turn]); return 'host'; }, dispose: () => disposed++};
  const client = {run: (...args) => { calls.push(['local', args]); return 'local'; }};
  const initialize = new Function(init[1], predicate[0] + helper[0] + '\nconst ' + adapter[0] + ';' + init[0] + ';return this._executionStrategy;');
  // The adapter and coordinator are the same for new turns, resume and summary.
  const strategy = initialize.call({agentClientService:client}, {executionStrategy:host});
  for (const action of ['userMessageAction', 'resumeAction', 'summarizeAction']) {
    for (const requested of [false, true]) {
      const model = {modelId:'chatgpt-codex/gpt-6.1-sol'};
      const turn = {ctx:{}, conversationState:{}, action:{case:action},
        modelDetails:requested ? undefined : model, runOptions:requested ? {requestedModel:model} : {}};
      assert.equal(await strategy.executeTurn(turn), 'local');
      assert.equal(calls.at(-1)[1][2], turn.action, 'Action passed to AgentClientService');
      assert.equal(calls.at(-1)[1][10], turn.runOptions, 'Run options preserved');
    }
  }
  for (const turn of [{modelDetails:{modelId:'cursor-model'}}, {},
    {modelDetails:{modelId:'chatgpt-codex/gpt-6.1-sol'},runOptions:{requestedModel:{modelId:'cursor-model'}}}]) {
    assert.equal(await strategy.executeTurn(turn), 'host');
    assert.equal(calls.at(-1)[1], turn);
  }
  strategy.dispose();
  assert.equal(disposed, 1);
  const legacy = initialize.call({agentClientService:client}, undefined);
  assert.equal(await legacy.executeTurn({}), 'local', 'Native legacy mode preserved');
}
