#!/usr/bin/env node
import { AssetLibrary } from './assets.js';

const [command, root, identity, source, ...extra] = process.argv.slice(2);
try {
  if (!root || extra.length || !(
    (command === 'list' && !identity && !source) ||
    (command === 'inspect' && identity && !source) ||
    (command === 'import' && identity && source)
  )) {
    throw new Error('Usage: digital-double list ROOT | inspect ROOT ID | import ROOT ID SOURCE_DIRECTORY');
  }
  const library = new AssetLibrary(root);
  let result;
  if (command === 'list') result = await library.list();
  if (command === 'import') result = await library.publish(identity, source);
  if (command === 'inspect') {
    result = await library.load(identity);
    if (!result) throw new Error(`Unknown identity: ${identity}`);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
