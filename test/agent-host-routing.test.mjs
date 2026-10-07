import test from 'node:test';
import assert from 'node:assert/strict';
import {agentHostRoutingAnchors, patchAgentHostRouting} from '../src/agent-host-routing.mjs';
import {verifyAgentHostRouting} from '../scripts/agent-host-routing-check.mjs';

for (const surface of ['desktop', 'glass']) {
  test('Agent Host routes subscription turns to AgentClientService: ' + surface, async () => {
    const anchor = agentHostRoutingAnchors[surface];
    const name = anchor.match(/new ([\w$]+)/)[1];
    const fixture = `${name}=class{constructor(e){this.agentClientService=e}executeTurn(e){return this.agentClientService.run(e.ctx,e.conversationState,e.action,e.modelDetails,e.interactionListener,e.resourceAccessor,e.blobStore,e.conversationActionManager,e.checkpointHandler,e.mcpTools,e.runOptions)}},Service=class{constructor(e){${anchor}}}`;
    await verifyAgentHostRouting(patchAgentHostRouting('function __isChatgptBridgeModel(m){return typeof m==="string"&&m.startsWith("chatgpt-codex/")}\n' + fixture, surface));
  });
}

test('Agent Host patch rejects missing and ambiguous anchors', () => {
  assert.throws(() => patchAgentHostRouting('', 'desktop'), /anchor not unique/);
  assert.throws(() => patchAgentHostRouting(agentHostRoutingAnchors.desktop.repeat(2), 'desktop'), /anchor not unique/);
  assert.throws(() => patchAgentHostRouting('', 'unknown'), /anchor not unique/);
});
