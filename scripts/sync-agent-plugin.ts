/**
 * Writes the agent plugin's generated files from their single sources:
 * - skills (agent-plugin/skills/{name}/SKILL.md) and slash commands (agent-plugin/commands/{name}.md)
 *   from src/domain/agentSkills.ts, which the Worker also serves;
 * - the "What's inside" counts in agent-plugin/README.md and README.md, from the tools the Worker
 *   really registers (services/mail-sync/src/agentApi.ts) and the skill and command lists.
 * Run with `npm run agent-plugin:sync`; the app and Worker tests fail if any of these drift.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentCommands, agentSkills, commandMarkdown, pluginContentsMarkdown, replaceGeneratedBlock, skillMarkdown } from '../src/domain/agentSkills';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'agent-plugin');

const skills = agentSkills();
for (const skill of skills) {
  const folder = join(plugin, 'skills', skill.name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), skillMarkdown(skill));
  console.log(`wrote agent-plugin/skills/${skill.name}/SKILL.md`);
}

const commands = agentCommands();
const commandFolder = join(plugin, 'commands');
mkdirSync(commandFolder, { recursive: true });
const wanted = new Set(commands.map((command) => `${command.name}.md`));
for (const file of readdirSync(commandFolder)) {
  if (file.endsWith('.md') && !wanted.has(file)) {
    rmSync(join(commandFolder, file));
    console.log(`removed agent-plugin/commands/${file}`);
  }
}
for (const command of commands) {
  writeFileSync(join(commandFolder, `${command.name}.md`), commandMarkdown(command));
  console.log(`wrote agent-plugin/commands/${command.name}.md`);
}

// The Worker is an ES module package with its own dependencies, so ask it in its own process.
const tools = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'scripts/registered-tools.ts'], { cwd: join(root, 'services', 'mail-sync'), encoding: 'utf8' })) as { public: string[]; account: string[] };
const contents = pluginContentsMarkdown({ publicTools: tools.public, accountTools: tools.account, skills, commands });
for (const file of [join(plugin, 'README.md'), join(root, 'README.md')]) {
  const key = file.startsWith(plugin) ? 'plugin-contents' : 'plugin-summary';
  writeFileSync(file, replaceGeneratedBlock(readFileSync(file, 'utf8'), key, contents[key]));
  console.log(`updated ${file.slice(root.length + 1)}`);
}
