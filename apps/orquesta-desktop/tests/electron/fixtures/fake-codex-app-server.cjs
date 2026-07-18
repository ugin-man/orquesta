const readline = require('node:readline');

let turnNumber = 0;
const turns = [];
const pendingApprovals = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = readline.createInterface({ input: process.stdin });

function completeTurn(turn, agentText, status = 'completed') {
  turn.status = status;
  turn.completedAt = Date.now() / 1_000;
  if (agentText) {
    turn.items.push({
      type: 'agentMessage',
      id: `agent-e2e-${turn.id}`,
      text: agentText,
      phase: 'final_answer'
    });
  }
  turns.push(turn);
  if (agentText) {
    send({
      method: 'item/completed',
      params: { threadId: 'thread-e2e', turnId: turn.id, item: turn.items.at(-1), completedAtMs: Date.now() }
    });
  }
  send({ method: 'turn/completed', params: { threadId: 'thread-e2e', turn } });
}

lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }

  if (!message.method && pendingApprovals.has(message.id)) {
    const turn = pendingApprovals.get(message.id);
    pendingApprovals.delete(message.id);
    const decision = message.result?.decision ?? 'unknown';
    completeTurn(turn, `Fake approval resolved with ${decision}.`);
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        codexHome: 'C:\\fake-codex-home',
        userAgent: 'fake-codex-app-server',
        platformFamily: 'windows',
        platformOs: 'windows'
      }
    });
    return;
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({
      id: message.id,
      result: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        cwd: message.params?.cwd ?? null,
        model: 'gpt-e2e-observed',
        modelProvider: 'fake',
        sandbox: 'workspace-write',
        thread: { id: 'thread-e2e', turns: [] }
      }
    });
    return;
  }
  if (message.method === 'turn/start') {
    const userText = message.params?.input?.find((item) => item.type === 'text')?.text ?? '';
    if (userText.includes('REJECT_DISPATCH')) {
      send({ id: message.id, error: { code: -32000, message: 'Fake runtime rejected dispatch before turn start.' } });
      return;
    }

    turnNumber += 1;
    const turnId = `turn-e2e-${turnNumber}`;
    const startedAt = Date.now() / 1_000;
    const turn = {
      id: turnId,
      status: 'inProgress',
      startedAt,
      completedAt: null,
      items: [{ type: 'userMessage', id: `user-e2e-${turnNumber}`, content: [{ type: 'text', text: userText }] }]
    };
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    setTimeout(() => {
      send({ method: 'turn/started', params: { threadId: 'thread-e2e', turn: { id: turnId, status: 'inProgress' } } });
      if (userText.includes('REQUEST_APPROVAL')) {
        const approvalId = `approval-e2e-${turnNumber}`;
        pendingApprovals.set(approvalId, turn);
        send({
          id: approvalId,
          method: 'item/fileChange/requestApproval',
          params: { itemId: `item-e2e-${turnNumber}`, startedAtMs: Date.now(), threadId: 'thread-e2e', turnId, reason: 'Fake file change' }
        });
      } else if (userText.includes('FAIL_TURN')) {
        send({
          method: 'error',
          params: { error: { message: 'Fake failure after turn start.' }, threadId: 'thread-e2e', turnId, willRetry: false }
        });
        completeTurn(turn, null, 'failed');
      } else {
        completeTurn(turn, 'Fake coordinator accepted the desktop instruction.');
      }
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
