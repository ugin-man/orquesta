const { appendFileSync } = require('node:fs');
const readline = require('node:readline');

let turnNumber = 0;
let inspectionThreadNumber = 0;
let lucaThreadNumber = 0;
const turnsByThread = new Map([['thread-e2e', []]]);
const profilesByThread = new Map();
const pendingApprovals = new Map();
const logPath = process.env.ORQUESTA_E2E_CODEX_LOG;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = readline.createInterface({ input: process.stdin });

function record(message) {
  if (!logPath || !message.method) return;
  appendFileSync(logPath, `${JSON.stringify({ method: message.method, params: message.params ?? null })}\n`, 'utf8');
}

function completeTurn(threadId, turn, agentText, status = 'completed') {
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
  const turns = turnsByThread.get(threadId) ?? [];
  turns.push(turn);
  turnsByThread.set(threadId, turns);
  if (agentText) {
    send({
      method: 'item/completed',
      params: { threadId, turnId: turn.id, item: turn.items.at(-1), completedAtMs: Date.now() }
    });
  }
  send({ method: 'turn/completed', params: { threadId, turn } });
}

function inspectionResponse(userText) {
  if (userText.includes('Use live Web search.')) {
    return JSON.stringify({
      outcome: 'report_ready',
      sourceCount: 1,
      markdown: '## Comparison axes\n\n- Product scope\n- Runtime boundary\n\n## Compared project\n\n[Example competitor](https://example.test/competitor)\n\nAccessed: 2026-07-21\n\n## Finding\n\nThe fixture comparison completed.'
    });
  }
  return JSON.stringify({
    outcome: 'report_ready',
    sourceCount: 0,
    markdown: '## Finding\n\n- Evidence reference: .orquesta/state/tasks.json\n- Severity: medium\n- Current impact: repeated coordination\n- Recommendation: keep one bounded review\n- Change cost: low\n- No-change risk: avoidable delay remains'
  });
}

function lucaResponse(userText) {
  let request = null;
  try { request = JSON.parse(userText)?.request ?? null; } catch {}
  return JSON.stringify({
    answer: `Luca explained ${request?.displayQuestion ?? 'the saved project records'}.`,
    points: ['The answer used only the bounded context supplied by Orquesta.'],
    uncertainties: [],
    references: []
  });
}

lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  record(message);

  if (!message.method && pendingApprovals.has(message.id)) {
    const pending = pendingApprovals.get(message.id);
    pendingApprovals.delete(message.id);
    const decision = message.result?.decision ?? 'unknown';
    completeTurn(pending.threadId, pending.turn, `Fake approval resolved with ${decision}.`);
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
  if (message.method === 'thread/start') {
    const luca = String(message.params?.developerInstructions ?? '').includes('You are Luca');
    const inspection = message.params?.sandbox === 'read-only' && !luca;
    const threadId = luca ? `thread-luca-${++lucaThreadNumber}` : inspection ? `thread-inspection-${++inspectionThreadNumber}` : 'thread-e2e';
    const profile = {
      approvalPolicy: message.params?.approvalPolicy ?? 'on-request',
      cwd: message.params?.cwd ?? null,
      sandbox: message.params?.sandbox ?? 'workspace-write',
      webSearchMode: message.params?.webSearchMode ?? null
    };
    profilesByThread.set(threadId, profile);
    if (!turnsByThread.has(threadId)) turnsByThread.set(threadId, []);
    send({
      id: message.id,
      result: {
        ...profile,
        approvalsReviewer: 'user',
        model: 'gpt-e2e-observed',
        modelProvider: 'fake',
        thread: { id: threadId, turns: [] }
      }
    });
    return;
  }
  if (message.method === 'thread/resume') {
    const threadId = message.params?.threadId ?? 'thread-e2e';
    const profile = profilesByThread.get(threadId) ?? {
      approvalPolicy: 'on-request', cwd: message.params?.cwd ?? null, sandbox: 'workspace-write', webSearchMode: null
    };
    send({
      id: message.id,
      result: {
        ...profile,
        approvalsReviewer: 'user',
        model: 'gpt-e2e-observed',
        modelProvider: 'fake',
        thread: { id: threadId, turns: turnsByThread.get(threadId) ?? [] }
      }
    });
    return;
  }
  if (message.method === 'turn/start') {
    const threadId = message.params?.threadId ?? 'thread-e2e';
    const userText = message.params?.input?.find((item) => item.type === 'text')?.text ?? '';
    if (userText.includes('REJECT_DISPATCH')) {
      send({ id: message.id, error: { code: -32000, message: 'Fake runtime rejected dispatch before turn start.' } });
      return;
    }

    turnNumber += 1;
    const inspection = threadId.startsWith('thread-inspection-');
    const luca = threadId.startsWith('thread-luca-');
    const turnId = inspection ? `turn-inspection-${turnNumber}` : luca ? `turn-luca-${turnNumber}` : `turn-e2e-${turnNumber}`;
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
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      if (inspection) {
        if (!userText.includes('HOLD_FOR_CANCEL')) completeTurn(threadId, turn, inspectionResponse(userText));
      } else if (luca) {
        completeTurn(threadId, turn, lucaResponse(userText));
      } else if (userText.includes('REQUEST_APPROVAL')) {
        const approvalId = `approval-e2e-${turnNumber}`;
        pendingApprovals.set(approvalId, { threadId, turn });
        send({
          id: approvalId,
          method: 'item/fileChange/requestApproval',
          params: { itemId: `item-e2e-${turnNumber}`, startedAtMs: Date.now(), threadId, turnId, reason: 'Fake file change' }
        });
      } else if (userText.includes('FAIL_TURN')) {
        send({
          method: 'error',
          params: { error: { message: 'Fake failure after turn start.' }, threadId, turnId, willRetry: false }
        });
        completeTurn(threadId, turn, null, 'failed');
      } else if (userText.includes('DELAY_TURN')) {
        setTimeout(() => completeTurn(threadId, turn, 'Fake delayed coordinator accepted the desktop instruction.'), 5_000);
      } else {
        completeTurn(threadId, turn, 'Fake coordinator accepted the desktop instruction.');
      }
    }, 20);
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'thread/read') {
    const threadId = message.params?.threadId ?? 'thread-e2e';
    send({ id: message.id, result: { thread: { id: threadId, turns: turnsByThread.get(threadId) ?? [] } } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `unsupported fake method: ${message.method}` } });
});

lines.on('close', () => process.exit(0));
