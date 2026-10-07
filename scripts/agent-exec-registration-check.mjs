import assert from 'node:assert/strict';

export function verifyAgentExecRegistration(source, {patched = true} = {}) {
  const gate = source.match(/function Cl\(e=\{\}\)\{return[^}]+\}/);
  assert.ok(gate, 'Agent-exec registration gate found');
  const registration = source.match(/function Pl\(e,t,r\)\{const n=function\(e=\{\}\)\{return Cl\(e\)\?"agent-exec-provider":"noop"\}[\s\S]*?invalidateChannel:n,provider:s\}\}/);
  assert.ok(registration, 'Native provider registration function found');
  const register = new Function('Il', 'K', gate[0] + registration[0] + ';return Pl;');
  let calls = 0;
  class Provider { constructor(...args) { this.args = args; } }
  const nativeApi = {cursor:{registerAgentExecProvider:provider => {calls++; return {provider, dispose(){}};}}};
  const setup = register(Provider, nativeApi);
  const resources = {factory:{},teamSettingsService:{},createTerminalExecutor(){},workspacePaths:['/home/seb/Repos'],loggerBackend:{},metricsBackend:{}};
  for (const options of [{registerAgentExecProvider:false}, {}]) {
    const context = {subscriptions:[]};
    const before = calls;
    const result = setup(context, options, resources);
    const enabled = patched || options.registerAgentExecProvider !== false;
    assert.equal(result.registered, enabled);
    assert.equal(calls - before, enabled ? 1 : 0, 'Native API called exactly once when enabled');
    assert.equal(result.invalidateChannel, enabled ? 'agent-exec-provider' : 'noop');
    assert.equal(context.subscriptions.length, enabled ? 2 : 0, 'Provider and registration have native disposal');
    if (enabled) assert.equal(result.provider.args[0], resources.factory);
  }
}
