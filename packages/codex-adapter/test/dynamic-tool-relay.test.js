const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createDynamicToolRelay,
  MAX_REQUEST_IDS_PER_PROVIDER_CONNECTION,
  TOOL_NAME
} = require('../src/dynamic-tool-relay');

const scope = {
  providerConnectionId: 'provider-1',
  correlationId: 'correlation-1',
  threadId: 'thread-1',
  turnId: 'turn-1'
};

function message(id = 'request-1', overrides = {}) {
  return {
    id,
    method: 'item/tool/call',
    params: {
      threadId: scope.threadId,
      turnId: scope.turnId,
      tool: TOOL_NAME,
      arguments: { capability: 'a'.repeat(64), cursor: null },
      callId: `call-${id}`,
      ...overrides
    }
  };
}

function handler() {
  const state = { calls: 0, expired: [], writeFailures: 0 };
  return {
    state,
    handle: async () => {
      state.calls += 1;
      return {
        response: { success: true, contentItems: [{ type: 'inputText', text: 'bounded' }] },
        onResponseWriteFailure: () => { state.writeFailures += 1; }
      };
    },
    expire: (reason) => state.expired.push(reason)
  };
}

test('relays one exact dynamic tool request without entering approval flow', async () => {
  const relay = createDynamicToolRelay();
  const registered = handler();
  relay.register({ ...scope, handler: registered });
  const responses = [];
  await relay.dispatch({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    message: message(),
    respond: (id, result) => responses.push({ id, result })
  });
  assert.equal(registered.state.calls, 1);
  assert.deepEqual(responses, [{
    id: 'request-1',
    result: { success: true, contentItems: [{ type: 'inputText', text: 'bounded' }] }
  }]);
});

test('fails closed for a sibling scope and never invokes its handler', async () => {
  const relay = createDynamicToolRelay();
  const registered = handler();
  relay.register({ ...scope, handler: registered });
  const responses = [];
  await relay.dispatch({
    providerConnectionId: scope.providerConnectionId,
    correlationId: 'sibling-correlation',
    message: message('request-sibling'),
    respond: (_id, result) => responses.push(result)
  });
  assert.equal(registered.state.calls, 0);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].success, false);
});

test('never evicts a seen request ID or writes a second response', async () => {
  const relay = createDynamicToolRelay();
  const registered = handler();
  relay.register({ ...scope, handler: registered });
  let responses = 0;
  const input = {
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    message: message('same-request'),
    respond: () => { responses += 1; }
  };
  await relay.dispatch(input);
  await relay.dispatch(input);
  assert.equal(registered.state.calls, 1);
  assert.equal(responses, 1);
});

test('converts an in-flight duplicate into the one fail-closed response and poisons the handler result', async () => {
  const relay = createDynamicToolRelay();
  let release;
  let writeFailures = 0;
  const registered = {
    handle: async () => {
      await new Promise((resolve) => { release = resolve; });
      return {
        response: { success: true, contentItems: [{ type: 'inputText', text: 'must-not-leak' }] },
        onResponseWriteFailure: () => { writeFailures += 1; }
      };
    },
    expire: () => {}
  };
  relay.register({ ...scope, handler: registered });
  const responses = [];
  const input = {
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    message: message('in-flight-duplicate'),
    respond: (_id, result) => responses.push(result)
  };
  const first = relay.dispatch(input);
  await new Promise((resolve) => setImmediate(resolve));
  await relay.dispatch(input);
  release();
  await first;
  assert.equal(responses.length, 1);
  assert.equal(responses[0].success, false);
  assert.equal(JSON.stringify(responses[0]).includes('must-not-leak'), false);
  assert.equal(writeFailures, 1);
});

test('expires the exact turn before a later request and leaves a sibling turn intact', async () => {
  const relay = createDynamicToolRelay();
  const first = handler();
  const sibling = handler();
  relay.register({ ...scope, handler: first });
  relay.register({ ...scope, correlationId: 'correlation-2', turnId: 'turn-2', handler: sibling });
  await relay.expireTurn(scope.providerConnectionId, scope.threadId, scope.turnId, 'turn_terminal');
  assert.deepEqual(first.state.expired, ['turn_terminal']);
  assert.deepEqual(sibling.state.expired, []);
  const responses = [];
  await relay.dispatch({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    message: message('after-terminal'),
    respond: (_id, result) => responses.push(result)
  });
  assert.equal(responses[0].success, false);
});

test('reserves and preflights locally before committing an exact Provider turn', async () => {
  const relay = createDynamicToolRelay();
  const registered = handler();
  let preflights = 0;
  let factories = 0;
  const factory = Object.assign(() => {
    factories += 1;
    return registered;
  }, { preflight: () => { preflights += 1; } });
  const reservation = relay.reserve({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    threadId: scope.threadId,
    handlerFactory: factory
  });
  assert.equal(preflights, 1);
  assert.equal(factories, 0);
  await reservation.commit(scope.turnId);
  assert.equal(factories, 1);
  const responses = [];
  await relay.dispatch({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    message: message('reserved-call'),
    respond: (_id, result) => responses.push(result)
  });
  assert.equal(responses[0].success, true);
});

test('does not retain a reservation when local preflight fails and permits a clean retry', async () => {
  const relay = createDynamicToolRelay();
  const rejected = Object.assign(() => handler(), { preflight: () => { throw new Error('preflight failed'); } });
  assert.throws(() => relay.reserve({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    threadId: scope.threadId,
    handlerFactory: rejected
  }), /preflight failed/u);
  const retry = relay.reserve({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    threadId: scope.threadId,
    handlerFactory: () => handler()
  });
  await retry.commit(scope.turnId);
});

test('rolls back and poisons a partially-created invalid handler on commit failure', async () => {
  const relay = createDynamicToolRelay();
  const expired = [];
  const reservation = relay.reserve({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    threadId: scope.threadId,
    handlerFactory: () => ({ expire: (reason) => expired.push(reason) })
  });
  await assert.rejects(reservation.commit(scope.turnId), /handler is invalid/u);
  assert.deepEqual(expired, ['registration_failed']);
  const retry = relay.reserve({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    threadId: scope.threadId,
    handlerFactory: () => handler()
  });
  await retry.commit('turn-retry');
});

test('poisons the broker result when the exact JSONL response write fails', async () => {
  const relay = createDynamicToolRelay();
  const registered = handler();
  relay.register({ ...scope, handler: registered });
  await relay.dispatch({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    message: message('write-loss'),
    respond: () => { throw new Error('write lost'); }
  });
  assert.equal(registered.state.writeFailures, 1);
});

test('retires a Provider connection at the exact bounded request-ID capacity without evicting tombstones', async () => {
  assert.equal(MAX_REQUEST_IDS_PER_PROVIDER_CONNECTION, 65_536);
  const retirements = [];
  const relay = createDynamicToolRelay({
    maxRequestIdsPerProviderConnection: 3,
    onProviderRetirementRequired: (...args) => retirements.push(args)
  });
  const registered = handler();
  relay.register({ ...scope, handler: registered });
  let responses = 0;
  for (const id of ['capacity-1', 'capacity-2', 'capacity-3']) {
    await relay.dispatch({
      providerConnectionId: scope.providerConnectionId,
      correlationId: scope.correlationId,
      message: message(id),
      respond: () => { responses += 1; }
    });
  }
  await relay.dispatch({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    message: message('capacity-overflow'),
    respond: (_id, result) => {
      responses += 1;
      assert.equal(result.success, false);
      assert.match(result.contentItems[0].text, /capacity_exhausted/u);
    }
  });
  assert.equal(responses, 4);
  assert.deepEqual(retirements, [[scope.providerConnectionId, 'dynamic_tool_request_id_capacity_exhausted']]);

  await relay.dispatch({
    providerConnectionId: scope.providerConnectionId,
    correlationId: scope.correlationId,
    message: message('capacity-after-retirement'),
    respond: () => { responses += 1; }
  });
  assert.equal(responses, 4);
  await relay.reset(scope.providerConnectionId);

  const replacementProvider = 'provider-2';
  const consumedCapabilityHandler = {
    handle: async () => ({
      response: { success: false, contentItems: [{ type: 'inputText', text: 'attachment_read_cursor_consumed' }] },
      onResponseWriteFailure: () => {}
    }),
    expire: () => {}
  };
  relay.register({ ...scope, providerConnectionId: replacementProvider, handler: consumedCapabilityHandler });
  const replacementResponses = [];
  await relay.dispatch({
    providerConnectionId: replacementProvider,
    correlationId: scope.correlationId,
    message: message('capacity-1'),
    respond: (_id, result) => replacementResponses.push(result)
  });
  assert.equal(replacementResponses.length, 1);
  assert.equal(replacementResponses[0].success, false);
  assert.equal(JSON.stringify(replacementResponses[0]).includes('bounded'), false);
});
