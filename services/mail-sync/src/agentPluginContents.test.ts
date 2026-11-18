/**
 * Drift guard: the tool, skill and command counts in agent-plugin/README.md and README.md are the
 * ones `npm run agent-plugin:sync` generates from what the Worker registers (ADR 0027).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { agentCommands, agentSkills, pluginContentsMarkdown, replaceGeneratedBlock } from '../../../src/domain/agentSkills';
import { registeredTools } from './agentApi.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

test('the plugin READMEs state the real number of tools, skills and commands', () => {
  const contents = pluginContentsMarkdown({ publicTools: registeredTools('public'), accountTools: registeredTools('account'), skills: agentSkills(), commands: agentCommands() });
  for (const [file, key] of [['agent-plugin/README.md', 'plugin-contents'], ['README.md', 'plugin-summary']] as const) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.equal(text, replaceGeneratedBlock(text, key, contents[key]), `run npm run agent-plugin:sync (${file})`);
  }
});
