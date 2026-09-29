// Derive the minified workbench symbols these patches anchor to from ORIGINAL
// Cursor bundles, locating each one by the role it plays rather than by name.
// Names are recycled between builds, so the output is reviewed and committed as
// part of a build's patch definitions; the installer never derives on the fly.
//
//   node scripts/derive-symbols.mjs <resources/app>
//   node scripts/derive-symbols.mjs --desktop <file> --glass <file> [--out <file>]
//
// The shared half of this file is kept in step with cursor-mercury-link's
// scripts/derive-symbols.mjs; the rest covers the Plan & Usage card, the login
// command and the notification service, which only this link and
// cursor-claude-link patch.
import fs from 'node:fs';
import path from 'node:path';

function deriveSharedSurface(source) {
  const problems = [];
  const out = {};
  const unique = (label, pattern) => {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) { problems.push(`${label}: ${matches.length} matches`); return null; }
    return matches[0];
  };
  const within = (label, text, pattern) => {
    const match = text.match(pattern);
    if (!match) problems.push(`${label}: not found`);
    return match;
  };
  const mostFrequent = (pattern, key) => {
    const counts = new Map();
    for (const m of source.matchAll(pattern)) counts.set(key(m), (counts.get(key(m)) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  if (source.includes('__chatgptBridgeBase') || source.includes('__claudeBridgeBase') || source.includes('__mercuryBridgeBase'))
    problems.push('bundle is already patched; derive symbols from original files');

  // Model picker sections
  const group = unique('groupReturn', /return ([\w$]+)\.mergeLeadingIntoPromotedSection===!0\?\{leading:\[\],promoted:\[\.\.\.([\w$]+),\.\.\.([\w$]+)\],others:([\w$]+)\}:\{leading:\2,promoted:\3,others:\4\}/g);
  if (group) out.groupReturn = group[0];
  const promoted = unique('promotedAnchor', /([\w$]+)\(([\w$]+),\{models:([\w$]+)\.promoted,title:([\w$]+)\?\.promotedSectionTitle/g);
  if (promoted) {
    Object.assign(out, {promotedAnchor: promoted[0], jsx: promoted[1], fmt: promoted[2], modelsVar: promoted[3]});
    const render = within('renderModel', source.slice(promoted.index, promoted.index + 600), /renderModel:([\w$]+)\},"promoted-models"/);
    if (render) out.renderModel = render[1];
  }

  // Default model list mapping that is persisted afterwards
  const map = unique('modelMap', /const ([\w$]+)=([\w$]+)\(([\w$]+)\);\3=\3\.map\(([\w$]+)=>([\w$]+)\(\4\)\),[\w$]+\(\(\)=>\{this\.persistAvailableDefaultMod/g);
  if (map) Object.assign(out, {mapPrefix: `const ${map[1]}=${map[2]}(${map[3]});`, mapVar: map[3], mapper: `${map[4]}=>${map[5]}(${map[4]})`});

  // Local agent run gate
  const run = unique('run', /async run\(([\w$,]+)\)\{const ([\w$]+)=([\w$]+)\(u,\{isRunningInTest:u\.isRunningInTest\?\?this\.environmentService\.enableSmokeTestDriver===!0,localMode:([\w$]+)\.localMode\}\);if\(\4\.localMode\)\{/g);
  if (run) Object.assign(out, {runAnchor: run[0], runLocalVar: run[2], runFn: run[3], localMode: run[4]});

  // Dedicated runtime host selector and the requested model in scope there
  const host = unique('dedicatedHost', /([\w$]+)\(this\.storageService,"useDedicatedLocalAgentRuntimeHost"\)\?await this\.runLocalAgentInDedicatedExtensionHost/g);
  if (host) {
    out.host = host[1];
    const intent = [...source.slice(Math.max(0, host.index - 3000), host.index).matchAll(/modelIntent:([\w$]+)/g)].pop();
    if (intent) out.hostModelVar = intent[1]; else problems.push('hostModelVar: not found');
  }
  const activation = unique('activation', /function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\.localMode&&\2\?\.get\(([\w$]+),-1\)==="true"\}/g);
  if (activation) out.activation = activation[0];

  // Settings > Models > API keys: the Google card and its building blocks
  const google = unique('googleCard', /\{apiName:"Google",description:/g);
  if (google) {
    const fnStart = source.lastIndexOf('function ', google.index);
    const fn = source.slice(fnStart, google.index + 400);
    const name = fn.match(/^function ([\w$]+)\(/);
    if (name) out.googleCard = name[1]; else problems.push('googleCard name: not found');
    const services = within('settings services', fn, /=([\w$]+)\([\w$]+,[\w$]+\),([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=\1\([\w$]+,([\w$]+)\),([\w$]+)=([\w$]+)\(\2\)/);
    if (services) Object.assign(out, {settingsService: services[1], useService: services[3], openerId: services[6], keyReader: services[8]});
    const description = within('description', fn, /([\w$]+)\(([\w$]+),\{children:\["You can put in"," ",([\w$]+)\(([\w$]+),\{onClick:\(\)=>\{[\w$]+\.open\("https:\/\/aistudio\.google\.com/);
    if (description) Object.assign(out, {jsxs: description[1], descriptionWrapper: description[2], keyJsx: description[3], link: description[4]});
    const generic = within('generic key card', fn, /([\w$]+)\(([\w$]+),\{apiName:"Google"/);
    if (generic) {
      out.genericKeyCard = generic[2];
      const cardFnAt = source.indexOf(`function ${generic[2]}(`);
      const cardFn = cardFnAt >= 0 ? source.slice(cardFnAt, cardFnAt + 6000) : '';
      const entry = within('api key entry', cardFn, /([\w$]+)\.Entry,\{label:"API Key",layout:"row",children:[\w$]+\(([\w$]+),\{ariaLabel:/);
      if (entry) Object.assign(out, {zs: entry[1], keyInput: entry[2]});
      const card = within('key card shell', cardFn, /[\w$]+\(([\w$]+),\{description:[\w$]+,title:[\w$]+,children:\[[\w$]+,[\w$]+\]\}\)/);
      if (card) out.card = card[1];
    }
    if (out.keyReader) {
      const readerAt = source.indexOf(`function ${out.keyReader}(`);
      const reader = readerAt >= 0 ? source.slice(readerAt, readerAt + 500) : '';
      const state = within('useState', reader, /const\[[\w$]+,[\w$]+\]=([\w$]+)\([\w$]+\)/);
      if (state) out.useState = state[1];
      const effect = within('useEffect', reader, /,([\w$]+)\([\w$]+,[\w$]+\),[\w$]+\}/);
      if (effect) out.useEffect = effect[1];
    }
    const composition = unique('googleCardComposition', new RegExp(`([\\w$]+)=([\\w$]+)\\(${(out.googleCard || '\\u0000').replace(/\$/g, '\\$')},\\{settingsWorkspace:([\\w$]+)\\}\\)`, 'g'));
    if (composition) out.googleCardComposition = composition[0];
  }
  const secrets = unique('secretStorageService', /([\w$]+)=[\w$]+\("secretStorageService"\)/g);
  if (secrets) out.secretStorage = secrets[1];

  // Subagent task bubble and lifecycle
  const wait = unique('waitForParentTaskBubble', /async _waitForParentTaskBubbleIfPossible\(([\w$]+)\)\{const ([\w$]+)=([\w$]+)\(\1\.parentConversationId\)/g);
  if (wait) out.trim = wait[3];
  out.taskV2 = mostFrequent(/([\w$]+)\.TASK_V2\b/g, m => m[1]);
  out.toolFormer = mostFrequent(/([\w$]+)\.TOOL_FORMER\b/g, m => m[1]);
  const params = unique('taskV2Params', /case:"taskV2Params",value:new ([\w$]+)\(/g);
  if (params) out.taskV2Params = params[1];
  const service = unique('subagentService', /invokeFunction\(([\w$]+)=>\1\.get\(([\w$]+)\)\)\.getLastTerminationReason/g);
  if (service) out.subagentService = service[2];
  const untrack = unique('conversationMap', /map:([\w$]+)\(\(\)=>([\w$]+)\.conversationMap\)\},this\.cachedConversationMapRef=/g);
  if (untrack) out.untrack = untrack[1];

  return {symbols: out, problems};
}

export function deriveSurface(source) {
  const {symbols, problems} = deriveSharedSurface(source);
  const unique = (label, pattern) => {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) { problems.push(`${label}: ${matches.length} matches`); return null; }
    return matches[0];
  };

  // Plan & Usage card: the component, its jsx call and the four children
  const usage = unique('planUsage', /([\w$]+)\(([\w$]+),\{legacyScrollGutter:[\w$]+,title:"Plan & Usage",children:\[([\w$,]+)\]\}\)/g);
  if (usage) {
    symbols.usageJsx = usage[1];
    symbols.usageChildren = `title:"Plan & Usage",children:[${usage[3]}]`;
    const header = [...source.slice(0, usage.index).matchAll(/function ([\w$]+)\(([\w$]+)\)\{const ([\w$]+)=([\w$]+)\((\d+)\)/g)].pop();
    if (header) symbols.usageFn = header[0]; else problems.push('usageFn: not found');
    // The hook aliases differ per module, so read the ones this component
    // actually calls rather than the nearest import.
    if (header) {
      const body = source.slice(header.index, usage.index);
      const only = (label, pattern) => {
        const names = new Set([...body.matchAll(pattern)].map(m => m[1]));
        if (names.size === 1) return [...names][0];
        problems.push(`${label}: ${names.size} candidates`);
        return null;
      };
      symbols.usageUseState = only('usageUseState', /\[[\w$]+,[\w$]+\]=([\w$]+)\(/g);
      symbols.usageUseEffect = only('usageUseEffect', /,([\w$]+)\(([\w$]+),([\w$]+)\);/g);
    }
  }
  const bars = new Set([...source.matchAll(/[\w$]+\(([\w$]+),\{[^{}]{0,200}?variant:"bar"/g)].map(m => m[1]));
  if (bars.size === 1) symbols.bar = [...bars][0]; else problems.push(`bar: ${bars.size} candidates`);
  const barStyle = unique('barStyle', /,([\w$]+)=\{\.\.\.[\w$]+,"--cursor-bg-accent":"var\(--cursor-bg-blue-primary\)"\}/g);
  if (barStyle) symbols.barStyle = barStyle[1];

  // Command registration pair and the notification service identifier
  const pairs = new Map();
  for (const m of source.matchAll(/([\w$]+)\(class extends ([\w$]+)\{constructor\(\)\{super\(\{id:"/g))
    pairs.set(m[1] + '|' + m[2], (pairs.get(m[1] + '|' + m[2]) || 0) + 1);
  const ranked = [...pairs.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length && ranked[0][1] > (ranked[1]?.[1] ?? 0) * 2) {
    [symbols.registerAction, symbols.actionBase] = ranked[0][0].split('|');
  } else problems.push('action pair: no clear winner');
  const notification = unique('notificationService', /([\w$]+)=[\w$]+\("notificationService"\)/g);
  if (notification) symbols.notificationService = notification[1];

  // Argument order of the provider configuration hook, spelled out per build
  const provider = unique('providerConfig', /async getLocalAgentProviderConfig\(([\w$]+),([\w$]+)\)\{/g);
  if (provider) symbols.providerConfig = provider[0];
  return {symbols, problems};
}

if (process.argv[1] && process.argv[1].endsWith('derive-symbols.mjs')) {
  const all = process.argv.slice(2);
  const outAt = all.indexOf('--out');
  const out = outAt >= 0 ? all[outAt + 1] : null;
  const args = outAt >= 0 ? [...all.slice(0, outAt), ...all.slice(outAt + 2)] : all;
  const files = {};
  if (args[0] === '--desktop' || args[0] === '--glass') for (let i = 0; i < args.length; i += 2) files[args[i].slice(2)] = args[i + 1];
  else {
    if (!args[0]) throw new Error('Usage: node scripts/derive-symbols.mjs <resources/app> | --desktop <file> --glass <file>');
    files.desktop = path.join(args[0], 'out/vs/workbench/workbench.desktop.main.js');
    files.glass = path.join(args[0], 'out/vs/workbench/workbench.glass.main.js');
  }
  const result = {}, problems = [];
  for (const [surface, file] of Object.entries(files)) {
    const {symbols, problems: found} = deriveSurface(fs.readFileSync(file, 'utf8'));
    result[surface] = symbols;
    problems.push(...found.map(p => `${surface}.${p}`));
  }
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  else console.log(JSON.stringify(result, null, 2));
  console.error(problems.length ? 'PROBLEMS:\n' + problems.map(p => '  - ' + p).join('\n') : 'problems: none');
  if (problems.length) process.exitCode = 1;
}
