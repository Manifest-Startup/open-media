/**
 * Prints the MCP tools the Worker registers, as JSON ({ public, account }). The root
 * `npm run agent-plugin:sync` runs it to generate the plugin READMEs' tool counts.
 */
import { registeredTools } from '../src/agentApi.js';

console.log(JSON.stringify({ public: registeredTools('public'), account: registeredTools('account') }));
