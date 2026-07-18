const readline = require('node:readline');

let turnNumber = 0;
const turns = [];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = readline.createInterface({ input: process.stdin });

lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialized') return;
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex-app-server', platformFamily: 'windows', platformOs: 'windows' } });
    return;
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: 'thread-e2e', turns: [] }, model: 'gpt-e2e-observed' } });
    return;
  }
  if (message.method === 'turn/start') {
    turnNumber += 1;
    const turnId = `turn-e2e-${turnNumber}`;
    const userText = message.params?.input?.find((item) => item.type === 'text')?.text ?? '';
    const startedAt = Date.now() / 1_000;
    const turn = {
      id: turnId, status: 'completed', startedAt, completedAt: startedAt + 0.1,
      items: [
        { type: 'userMessage', id: `user-e2e-${turnNumber}`, content: [{ type: 'text', text: userText }] },
        { type: 'agentMessage', id: `agent-e2e-${turnNumber}`, text: 'Fake coordinator accepted the desktop instruction.', phase: 'final_answer' }
      ]
    };
    turns.push(turn);
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    setTimeout(() => {
      send({ method: 'turn/started', params: { threadId: 'thread-e2e', turn: { id: turnId, status: 'inProgress' } } });
      send({ method: 'item/completed', params: { threadId: 'thread-e2e', turnId, item: turn.items[1], completedAtMs: Date.now() } });
      send({ method: 'turn/completed', params: { threadId: 'thread-e2e', turn } });
    }, 20);
    return;
  }
  if (message.method === 'thread/read') {
    send({ id: message.id, result: { thread: { id: 'thread-e2e', turns } } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `unsupported fake method: ${message.method}` } });
});

lines.on('close', () => process.exit(0));
