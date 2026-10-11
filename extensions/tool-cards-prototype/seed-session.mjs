// THROWAWAY: build replay fixtures from native read/bash results. No model requests and no project mutations.
import { SessionManager, createReadToolDefinition, createBashToolDefinition } from '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js';

const session = SessionManager.create(process.cwd(), process.argv[2]);
const usage = { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} };
session.appendCustomMessageEntry('prototype-reference', 'Reference: CREW MESSAGE', true);
const samples = [
  ['read', { path:'README.md', offset:1, limit:12 }],
  ['bash', { command:"printf 'Building preview...\\nNative output preserved.\\n'" }],
  ['bash', { command:'true' }],
  ['bash', { command:"printf 'Preview error: permission denied\\n' >&2; exit 1" }],
];
for (const [i, [name, args]] of samples.entries()) {
  const id = `prototype-${i}`;
  session.appendMessage({ role:'assistant', content:[{type:'toolCall',id,name,arguments:args}], api:'prototype',provider:'prototype',model:'synthetic-fixture',usage,stopReason:'toolUse',timestamp:Date.now() });
  const definition = name === 'read' ? createReadToolDefinition(process.cwd()) : createBashToolDefinition(process.cwd());
  const started = performance.now();
  let result, isError = false;
  try { result = await definition.execute(id,args); isError = result.isError === true; }
  catch (error) { result={content:[{type:'text',text:error.message}],details:undefined}; isError=true; }
  session.appendMessage({ role:'toolResult',toolCallId:id,toolName:name,...result,isError,durationMs:performance.now()-started,timestamp:Date.now() });
}
session.appendModelChange(process.env.PI_PROVIDER, process.env.PI_MODEL);
session.appendSessionInfo('Throwaway Pi tool-card prototype');
console.log(session.getSessionFile());
