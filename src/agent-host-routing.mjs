// Agent Host passes its own execution strategy into AgentCompatService. Route
// subscription turns through the existing AgentClientService strategy instead,
// so run, resume and summarize all use the patched provider configuration.
export const agentHostRoutingPrelude = `
function __chatgptRouteExecutionStrategy(host, local) {
  if (!host) return local;
  return {
    executeTurn(turn) {
      const model = turn.runOptions?.requestedModel?.modelId ?? turn.modelDetails?.modelId;
      return (__isChatgptBridgeModel(model) ? local : host).executeTurn(turn);
    },
    dispose() { host.dispose?.(); }
  };
}
`;

export const agentHostRoutingAnchors = {
  desktop: 'this._executionStrategy=e?.executionStrategy??new Tnh(this.agentClientService)',
  glass: 'this._executionStrategy=t?.executionStrategy??new r$m(this.agentClientService)'
};

export function patchAgentHostRouting(source, surface) {
  const anchor = agentHostRoutingAnchors[surface];
  if (!anchor || source.split(anchor).length !== 2) {
    throw new Error('Agent Host routing anchor not unique: ' + surface);
  }
  const [host, local] = anchor.slice('this._executionStrategy='.length).split('??');
  return agentHostRoutingPrelude + source.replace(anchor,
    `this._executionStrategy=__chatgptRouteExecutionStrategy(${host},${local})`);
}
