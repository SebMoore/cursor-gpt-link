import test from 'node:test';
import assert from 'node:assert/strict';
import {patchAgentExecRegistration} from '../src/agent-exec-registration.mjs';
import {verifyAgentExecRegistration} from '../scripts/agent-exec-registration-check.mjs';

const original = 'function Cl(e={}){return!1!==e.registerAgentExecProvider}function Pl(e,t,r){const n=function(e={}){return Cl(e)?"agent-exec-provider":"noop"}(t);let s;const o=r.registerAgentExecProvider??(e=>K.cursor.registerAgentExecProvider(e));var i;return{registered:!!Cl((i={options:t,register:()=>{s=new Il(r.factory,r.teamSettingsService,r.createTerminalExecutor,r.workspacePaths,r.loggerBackend,r.metricsBackend),e.subscriptions.push(s);const t=o(s);e.subscriptions.push(t)}}).options)&&(i.register(),!0),invalidateChannel:n,provider:s}}';

test('Agent Host disabled registration reproduces the missing provider; bridge patch registers it', () => {
  verifyAgentExecRegistration(original, {patched:false});
  verifyAgentExecRegistration(patchAgentExecRegistration(original));
});

test('Registration patch is idempotent and rejects changed or duplicate gates', () => {
  const patched = patchAgentExecRegistration(original);
  assert.equal(patchAgentExecRegistration(patched), patched);
  assert.equal(patchAgentExecRegistration('older dedicated runtime'), 'older dedicated runtime');
  assert.throws(() => patchAgentExecRegistration(original.repeat(2)), /not unique/);
  assert.throws(() => patchAgentExecRegistration('registerAgentExecProvider:changed'), /not unique/);
});
