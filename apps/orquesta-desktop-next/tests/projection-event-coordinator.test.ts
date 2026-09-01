import { describe, expect, it } from 'vitest';
import { ProjectionEventCoordinator } from '../runtime-node/projection-event-coordinator';

function harness() {
  const appended: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const coordinator = new ProjectionEventCoordinator({
    notify: (value) => {
      notifications.push(value);
      if (value.type === 'projection.events.ingest') {
        const event = value.event as { events?: Array<Record<string, unknown>> } | undefined;
        appended.push(...(event?.events ?? []));
      }
    },
    now: () => '2026-08-16T11:00:00.000Z',
  });
  coordinator.bind({
    projectId: 'project-a',
    runtimeGeneration: 'runtime-a',
    activationToken: 'activation-a',
    rendererSessionId: 'renderer-a',
    rendererGeneration: 3,
    expectedStatusRevision: 7,
  });
  return { coordinator, appended, notifications };
}

describe('ProjectionEventCoordinator', () => {
  it('projects provider lifecycle and public messages without raw frames', () => {
    const state = harness();
    state.coordinator.observeCoreEvent({
      type: 'runtime.notification',
      notification: {
        kind: 'provider_event',
        threadId: 'thread-a',
        turnId: 'turn-a',
        targetAgentId: 'orchestrator',
        occurredAt: '2026-08-16T11:00:00.000Z',
        providerEvent: {
          provider_stream_id: 'provider-a',
          provider_sequence: 7,
          event_type: 'item.started',
          scope: { thread_id: 'thread-a', turn_id: 'turn-a', item_id: 'item-a' },
          payload: { item_id: 'item-a', item_type: 'commandExecution', item_status: 'inProgress', content_omitted: true },
          source: { frame_sha256: 'must-not-cross' },
        },
      },
    });
    state.coordinator.observeResponse(
      'runtime.send',
      { messageId: 'message-a', text: 'hello', targetAgentId: 'orchestrator' },
      { type: 'runtime.dispatch.accepted', threadId: 'thread-a', turnId: 'turn-a' },
    );

    expect(state.appended).toHaveLength(3);
    expect(state.appended[0]).toMatchObject({
      domainEventVersion: 1,
      sourceEventId: expect.stringMatching(/^src_[a-f0-9]{64}$/u),
      sourceCursor: 'provider-a:7',
      owner: { kind: 'agent', agentId: 'orchestrator' },
      agentId: 'orchestrator',
      kind: 'item.started',
      itemId: 'item-a',
      payload: { item_id: 'item-a', item_type: 'commandExecution', item_status: 'inProgress', content_omitted: true, visibility: 'public' },
    });
    expect(JSON.stringify(state.appended)).not.toContain('must-not-cross');
    expect(state.appended[1]).toMatchObject({
      domainEventVersion: 1,
      sourceEventId: expect.stringMatching(/^src_[a-f0-9]{64}$/u),
      owner: { kind: 'agent', agentId: 'orchestrator' },
      kind: 'turn.accepted',
      phase: 'accepted',
      itemId: 'projection-turn-lifecycle-v1-7482c1375e448a625065842c41e79f9bd856fc001090d00d9e1d211108e72bd4',
    });
    expect(state.appended[2]).toMatchObject({
      kind: 'conversation.message',
      itemId: 'message-a',
      payload: {
        messageId: 'projection-message-v1-ab8c0a1714b2bbca5a1f666a5232681dc577e315682a1449a29954412563c923',
        role: 'user', text: 'hello', visibility: 'public'
      },
    });
    expect(state.notifications.some((entry) => entry.type === 'projection.events.ingest')).toBe(true);
  });

  it('projects only public agent answer deltas with a stable final message id', () => {
    const state = harness();
    state.coordinator.observeCoreEvent({
      type: 'runtime.notification',
      notification: {
        kind: 'provider_event',
        threadId: 'thread-a',
        turnId: 'turn-a',
        targetAgentId: 'orchestrator',
        providerEvent: {
          provider_stream_id: 'provider-a',
          provider_sequence: 8,
          event_type: 'message.agent.delta',
          scope: { thread_id: 'thread-a', turn_id: 'turn-a', item_id: 'item-answer-a' },
          payload: { item_id: 'item-answer-a', delta: '返答の一部' },
          source: { frame_sha256: 'must-not-cross' },
        },
      },
    });
    expect(state.appended).toEqual([expect.objectContaining({
      kind: 'message.agent.delta',
      phase: 'streaming',
      itemId: 'item-answer-a',
      payload: {
        messageId: 'projection-message-v1-9290a7cd71a0645fe199da1238c7653af323965e139aa2e7e1ebc2da62281d23',
        role: 'agent',
        delta: '返答の一部',
        targetAgentId: 'orchestrator',
        visibility: 'public',
      },
    })]);
    expect(JSON.stringify(state.appended)).not.toContain('must-not-cross');
  });

  it('forwards only the bounded typed structured activity payload', () => {
    const state = harness();
    state.coordinator.observeCoreEvent({
      type: 'runtime.notification',
      notification: {
        kind: 'provider_event',
        threadId: 'thread-a',
        turnId: 'turn-a',
        targetAgentId: 'orchestrator',
        providerEvent: {
          provider_stream_id: 'provider-a',
          provider_sequence: 9,
          event_type: 'command.started',
          scope: { thread_id: 'thread-a', turn_id: 'turn-a', item_id: 'command-a' },
          payload: {
            activity_kind: 'command',
            activity_state: 'running',
            title: 'Run powershell.exe',
            command_name: 'powershell.exe',
            action_types: ['unknown'],
            action_types_truncated: false,
            exit_code: null,
            duration_ms: null,
            output_present: false,
            output_bytes: 0,
            output_text: null,
            output_truncated: false,
            output_redacted: false,
            cwd_omitted: true,
            command_arguments_omitted: true,
            content_omitted: true,
            raw: 'secret-that-must-never-reach-the-journal',
          },
          source: { frame_sha256: 'must-not-cross' },
        },
      },
    });
    expect(state.appended).toEqual([expect.objectContaining({
      sourceCursor: 'provider-a:9',
      agentId: 'orchestrator',
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'command-a',
      kind: 'command.started',
      phase: 'started',
      payload: expect.objectContaining({
        activity_kind: 'command',
        activity_state: 'running',
        command_name: 'powershell.exe',
        command_arguments_omitted: true,
        content_omitted: true,
        visibility: 'public',
      }),
    })]);
    expect(JSON.stringify(state.appended)).not.toContain('must-not-cross');
    expect(JSON.stringify(state.appended)).not.toContain('secret-that-must-never-reach-the-journal');
  });

  it('keeps ownerless inspection and workflow deltas and final messages out of the conversation journal', () => {
    const state = harness();
    state.coordinator.observeCoreEvent({
      type: 'runtime.notification',
      notification: {
        kind: 'provider_event',
        threadId: 'inspection-thread',
        turnId: 'inspection-turn',
        targetAgentId: null,
        providerEvent: {
          provider_stream_id: 'provider-inspection',
          provider_sequence: 1,
          event_type: 'message.agent.delta',
          scope: { thread_id: 'inspection-thread', turn_id: 'inspection-turn', item_id: 'inspection-answer' },
          payload: { item_id: 'inspection-answer', delta: 'internal inspection output' },
        },
      },
    });
    state.coordinator.observeCoreEvent({
      type: 'runtime.notification',
      notification: {
        kind: 'agent_message',
        threadId: 'inspection-thread',
        turnId: 'inspection-turn',
        itemId: 'inspection-answer',
        targetAgentId: null,
        text: 'internal inspection final output',
      },
    });
    expect(state.appended).toEqual([]);
    expect(state.notifications.some((entry) => entry.type === 'projection.fault')).toBe(false);
  });

  it('records the approval request once and leaves accepted resolution to Native', () => {
    const state = harness();
    state.coordinator.observeCoreEvent({
      type: 'runtime.approval.requested',
      approval: {
        requestId: 'apr_1',
        projectId: 'project-a',
        providerConnectionId: 'provider-a',
        threadId: 'thread-a',
        turnId: 'turn-a',
        targetAgentId: 'orchestrator',
        method: 'item/commandExecution/requestApproval',
        reason: 'Run command?',
        responseOptions: ['accept', 'decline'],
        requestedEffect: { kind: 'command_execution', itemId: 'item-a' },
      },
    });
    state.coordinator.observeResponse(
      'runtime.approval.respond',
      { attentionId: 'runtime-approval-apr_1', decision: 'accept' },
      { type: 'runtime.approval.accepted', decision: 'accept' },
    );
    expect(state.appended.map((entry) => entry.kind)).toEqual([
      'attention.approval_requested',
    ]);
    expect(state.appended[0]).toMatchObject({
      itemId: 'runtime-approval-apr_1',
      payload: { requestKey: 'runtime-approval-apr_1', prompt: null },
    });
  });

  it('records the exact accepted interrupt lifecycle without inventing another turn', () => {
    const state = harness();
    state.coordinator.observeResponse(
      'runtime.turn.interrupt',
      { targetAgentId: 'orchestrator', threadId: 'thread-a', turnId: 'turn-a' },
      { type: 'runtime.turn.interrupt.accepted', targetAgentId: 'orchestrator', threadId: 'thread-a', turnId: 'turn-a' },
    );
    expect(state.appended).toEqual([expect.objectContaining({
      agentId: 'orchestrator',
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'projection-turn-lifecycle-v1-ff589b958eb3afacbe0feed7d0a1267633d591144a753abf922135c2ed937381',
      kind: 'turn.interrupt_accepted',
      phase: 'interrupting',
    })]);
  });

  it('projects an accepted Steer as an ordered user message on the same turn', () => {
    const state = harness();
    state.coordinator.observeResponse(
      'runtime.turn.steer',
      {
        steerId: 'steer-a', text: '根本原因を先に確認して', targetAgentId: 'orchestrator',
        threadId: 'thread-a', turnId: 'turn-a',
      },
      {
        type: 'runtime.turn.steer.accepted', steerId: 'steer-a', targetAgentId: 'orchestrator',
        threadId: 'thread-a', turnId: 'turn-a',
      },
    );
    expect(state.appended).toEqual([expect.objectContaining({
      agentId: 'orchestrator',
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'steer-a',
      kind: 'conversation.message',
      phase: 'completed',
      payload: expect.objectContaining({
        role: 'user', text: '根本原因を先に確認して', targetAgentId: 'orchestrator', visibility: 'public',
      }),
    })]);
  });

  it('emits send and interrupt lifecycle events only through the ingest route', () => {
    const notifications: Array<Record<string, unknown>> = [];
    const coordinator = new ProjectionEventCoordinator({
      notify: (value) => notifications.push(value),
      now: () => '2026-08-16T11:00:00.000Z',
    });
    coordinator.bind({
      projectId: 'project-a',
      runtimeGeneration: 'runtime-a',
      activationToken: 'activation-a',
      rendererSessionId: 'renderer-a',
      rendererGeneration: 3,
      expectedStatusRevision: 7,
    });
    coordinator.observeResponse(
      'runtime.send',
      { messageId: 'message-real', text: 'hello', targetAgentId: 'orchestrator' },
      { type: 'runtime.dispatch.accepted', threadId: 'thread-real', turnId: 'turn-real' },
    );
    coordinator.observeResponse(
      'runtime.turn.interrupt',
      { targetAgentId: 'orchestrator', threadId: 'thread-real', turnId: 'turn-real' },
      { type: 'runtime.turn.interrupt.accepted', threadId: 'thread-real', turnId: 'turn-real' },
    );
    const emitted = notifications
      .filter((entry) => entry.type === 'projection.events.ingest')
      .flatMap((entry) => (entry.event as { events: Array<Record<string, unknown>> }).events);
    expect(emitted.map((event) => event.kind)).toEqual([
      'turn.accepted', 'conversation.message', 'turn.interrupt_accepted',
    ]);
    expect(emitted[0].itemId).toMatch(/^projection-turn-lifecycle-v1-[0-9a-f]{64}$/u);
    expect(emitted[2].itemId).toMatch(/^projection-turn-lifecycle-v1-[0-9a-f]{64}$/u);
    expect(notifications.some((entry) => entry.type === 'projection.fault')).toBe(false);
    coordinator.unbind();
  });

  it('echoes the exact immutable native authority on every ingest frame', () => {
    const state = harness();
    state.coordinator.observeResponse(
      'runtime.turn.interrupt',
      { targetAgentId: 'orchestrator', threadId: 'thread-a', turnId: 'turn-a' },
      { type: 'runtime.turn.interrupt.accepted', threadId: 'thread-a', turnId: 'turn-a' },
    );
    const frame = state.notifications.find((entry) => entry.type === 'projection.events.ingest');
    expect(frame?.event).toEqual(expect.objectContaining({
      projectId: 'project-a',
      runtimeGeneration: 'runtime-a',
      activationToken: 'activation-a',
      rendererSessionId: 'renderer-a',
      rendererGeneration: 3,
      expectedStatusRevision: 7,
    }));
  });

  it('buffers suspended events in order and flushes them under only the new native authority', async () => {
    const state = harness();
    const oldBinding = {
      projectId: 'project-a', runtimeGeneration: 'runtime-a', activationToken: 'activation-a',
      rendererSessionId: 'renderer-a', rendererGeneration: 3, expectedStatusRevision: 7,
    };
    state.coordinator.suspend(oldBinding);
    state.coordinator.observeResponse(
      'runtime.turn.interrupt',
      { targetAgentId: 'first', threadId: 'thread-a', turnId: 'turn-a' },
      { type: 'runtime.turn.interrupt.accepted', threadId: 'thread-a', turnId: 'turn-a' },
    );
    state.coordinator.observeResponse(
      'runtime.turn.interrupt',
      { targetAgentId: 'second', threadId: 'thread-b', turnId: 'turn-b' },
      { type: 'runtime.turn.interrupt.accepted', threadId: 'thread-b', turnId: 'turn-b' },
    );
    expect(state.notifications).toHaveLength(0);
    state.coordinator.bind({
      ...oldBinding,
      activationToken: 'activation-b',
      rendererSessionId: 'renderer-b',
      rendererGeneration: 4,
      expectedStatusRevision: 8,
    });
    expect(state.notifications).toHaveLength(0);
    await Promise.resolve();
    const frames = state.notifications.filter((entry) => entry.type === 'projection.events.ingest');
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect(frame.event).toEqual(expect.objectContaining({
        activationToken: 'activation-b',
        rendererSessionId: 'renderer-b',
        rendererGeneration: 4,
        expectedStatusRevision: 8,
      }));
    expect(frames.flatMap((frame) => (
      frame.event as { events: Array<Record<string, unknown>> }
    ).events).map((event) => event.agentId)).toEqual(['first', 'second']);
  });

  it('fails closed instead of growing the suspended event buffer without bound', () => {
    const notifications: Array<Record<string, unknown>> = [];
    const coordinator = new ProjectionEventCoordinator({
      notify: (value) => notifications.push(value),
      suspendedBufferLimit: 1,
      suspendedBufferBytes: 1024,
    });
    const binding = {
      projectId: 'project-a', runtimeGeneration: 'runtime-a', activationToken: 'activation-a',
      rendererSessionId: 'renderer-a', rendererGeneration: 3, expectedStatusRevision: 7,
    };
    coordinator.bind(binding);
    coordinator.suspend(binding);
    for (const suffix of ['a', 'b']) coordinator.observeResponse(
      'runtime.turn.interrupt',
      { targetAgentId: suffix, threadId: `thread-${suffix}`, turnId: `turn-${suffix}` },
      { type: 'runtime.turn.interrupt.accepted', threadId: `thread-${suffix}`, turnId: `turn-${suffix}` },
    );
    expect(notifications.some((entry) => entry.type === 'projection.events.ingest')).toBe(false);
    expect(notifications.some((entry) => entry.type === 'projection.fault')).toBe(true);
    expect(() => coordinator.bind({ ...binding, expectedStatusRevision: 8 })).toThrow(
      'suspended-event buffer exceeded its bound',
    );
  });
});
