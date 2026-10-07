// Run after connecting Cursor to a WSL distribution at least once.
import {connectWsl, installRemote, restoreRemote} from '../src/remote-runtime.mjs';
import {link, marker, prefix, patchRuntime} from '../src/runtime-link.mjs';

const [distribution, ...flags] = process.argv.slice(2);
if (!distribution || distribution.startsWith('--') || flags.some(flag => !['--check', '--restore'].includes(flag))) {
  throw new Error('Usage: node scripts/install-wsl.mjs DISTRIBUTION [--check | --restore]');
}
if (flags.includes('--check') && flags.includes('--restore')) throw new Error('Choose --check or --restore');
const options = {host:'WSL:' + distribution, transport:connectWsl(distribution), link, marker, prefix, patchRuntime};
if (flags.includes('--restore')) restoreRemote(options);
else installRemote({...options, check:flags.includes('--check')});
