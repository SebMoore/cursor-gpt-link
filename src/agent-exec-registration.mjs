// Agent Host activates the shared agent-exec runtime with registration disabled.
// Bridge turns still use that runtime, so its native provider must coexist with
// the Agent Host provider. This changes registration, not ordinary model routing.
export function patchAgentExecRegistration(source) {
  const marker = '/* cursor-chatgpt-bridge: register agent-exec alongside Agent Host */';
  if (source.includes(marker)) return source;
  if (!source.includes('registerAgentExecProvider')) return source; // Older/dedicated runtimes.
  const matches = [...source.matchAll(/function ([\w$]+)\(e=\{\}\)\{return!1!==e\.registerAgentExecProvider\}/g)];
  if (matches.length !== 1) throw new Error('Agent-exec registration gate not unique');
  return source.replace(matches[0][0], `function ${matches[0][1]}(e={}){return!0${marker}}`);
}
