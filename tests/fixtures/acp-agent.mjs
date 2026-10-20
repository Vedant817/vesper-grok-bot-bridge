import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let prompt;
input.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'session-1', models: { currentModelId: 'fixture', availableModels: [{ modelId: 'fixture', name: 'Fixture' }] } } });
  else if (m.method === 'session/set_model') send({ id: m.id, result: {} });
  else if (m.method === 'session/prompt') {
    prompt = m.id;
    send({ id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'session-1', toolCall: { title: 'Delete files' }, options: [{ optionId: 'no', kind: 'reject_once' }, { optionId: 'yes', kind: 'allow_once' }] } });
  } else if (m.id === 'permission-1') {
    if (m.result?.outcome?.optionId !== 'no') process.exit(4);
    send({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Declined dangerous command\n' } } } });
    send({ id: prompt, result: { stopReason: 'end_turn' } });
  } else if (m.method === 'session/cancel') send({ id: prompt, result: { stopReason: 'cancelled' } });
});
