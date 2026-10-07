import test from 'node:test';
import assert from 'node:assert/strict';
import {connectWsl, serverDirectory} from '../src/remote-runtime.mjs';

test('WSL transport finds flat and platform-nested server layouts without shell interpolation', () => {
  const calls = [];
  const distribution = 'Ubuntu; shell metacharacters';
  const transport = connectWsl(distribution, (file, args, options) => {
    calls.push({file, args, options});
    return '/home/seb/.cursor-server/bin/abc/\n/home/seb/.cursor-server/bin/linux-x64/def/\n';
  });
  assert.equal(serverDirectory(transport, 'abc').dir, '/home/seb/.cursor-server/bin/abc');
  assert.equal(serverDirectory(transport, 'def').dir, '/home/seb/.cursor-server/bin/linux-x64/def');
  assert.equal(calls[0].file, 'wsl.exe');
  assert.deepEqual(calls[0].args.slice(0, 5), ['--distribution', distribution, '--exec', 'sh', '-c']);
  assert.ok(!calls[0].args[5].includes(distribution));
  transport.write('/home/seb/a', 'Unicode: é');
  assert.equal(calls.at(-1).options.input, Buffer.from('Unicode: é').toString('base64'));
  assert.throws(() => connectWsl(''), /distribution required/);
});
