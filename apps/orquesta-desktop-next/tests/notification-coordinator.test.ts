import { describe, expect, test } from 'vitest';
import { NotificationCoordinator, type NotificationGateway } from '../src/application/notification-coordinator';
import { createInitialApplicationState, type ApplicationState } from '../src/application/state';
import { previewSnapshot } from '../src/testing/preview-client';
import { UserSignalTracker, type UserSignal } from '../src/presentation/user-signals';

class RecordingNotificationGateway implements NotificationGateway {
  permissionChecks = 0;
  permissionRequests = 0;
  notifications: Array<{ title: string; body: string }> = [];

  async isPermissionGranted(): Promise<boolean> {
    this.permissionChecks += 1;
    return true;
  }

  async requestPermission(): Promise<'granted'> {
    this.permissionRequests += 1;
    return 'granted';
  }

  async notify(input: { title: string; body: string }): Promise<void> {
    this.notifications.push(structuredClone(input));
  }
}

function state(patch: Partial<ApplicationState> = {}): ApplicationState {
  return {
    ...createInitialApplicationState(),
    phase: 'workspace',
    selectedProjectId: previewSnapshot.project.id,
    snapshot: structuredClone(previewSnapshot),
    selectedAgentId: 'orchestrator',
    runtimeAuthority: {
      projectId: previewSnapshot.project.id,
      activationToken: 'notification-test-activation',
      rendererSessionId: 'notification-test-renderer',
      rendererGeneration: 1,
    },
    userSignalsBaselineReady: true,
    settings: {
      schemaVersion: 2, revision: 1, locale: 'en', theme: 'system',
      reducedMotion: false, notificationsEnabled: true, navigationCompact: true, workLedgerOpen: true,
    },
    ...patch,
  };
}

describe('NotificationCoordinator', () => {
  test('uses the first projection as a baseline and never requests permission on startup', async () => {
    const gateway = new RecordingNotificationGateway();
    const coordinator = new NotificationCoordinator(gateway);
    await coordinator.observe(state({
      messages: [{
        id: 'old', role: 'agent', targetAgentId: 'orchestrator', authorLabel: 'ORCHESTRATOR',
        text: 'old private answer', createdAt: '2026-08-28T00:00:00.000Z', evidenceLabel: null,
      }],
    }), 'en', { visible: false, focused: false });

    expect(gateway.notifications).toEqual([]);
    expect(gateway.permissionChecks).toBe(0);
    expect(gateway.permissionRequests).toBe(0);
  });

  test('sends one bounded notification for a new final reply and ignores replay or older paging', async () => {
    const gateway = new RecordingNotificationGateway();
    const coordinator = new NotificationCoordinator(gateway);
    const initial = state({ messages: [] });
    await coordinator.observe(initial, 'en', { visible: false, focused: false });

    const sensitiveSnapshot = structuredClone(previewSnapshot);
    sensitiveSnapshot.project.title = 'SECRET CUSTOMER PROJECT';
    sensitiveSnapshot.agents.find((agent) => agent.id === 'orchestrator')!.displayName = 'SECRET ACCOUNT OWNER';
    const current = state({
      snapshot: sensitiveSnapshot,
      messages: [{
        id: 'new', role: 'agent', targetAgentId: 'orchestrator', authorLabel: 'ORCHESTRATOR',
        text: 'secret C:\\private\\customer.csv attachment invoice.pdf',
        createdAt: '2026-08-28T10:00:00.000Z', evidenceLabel: null,
      }],
    });
    await coordinator.observe(current, 'en', { visible: false, focused: false });
    await coordinator.observe(current, 'en', { visible: false, focused: false });
    await coordinator.observe(state({
      messages: [{
        id: 'older-page', role: 'agent', targetAgentId: 'orchestrator', authorLabel: 'ORCHESTRATOR',
        text: 'older replay', createdAt: '2026-08-27T10:00:00.000Z', evidenceLabel: null,
      }, ...current.messages],
    }), 'en', { visible: false, focused: false });

    expect(gateway.notifications).toHaveLength(1);
    expect(gateway.notifications[0]).toMatchObject({ title: 'New reply' });
    expect(JSON.stringify(gateway.notifications[0])).not.toMatch(/secret|private|customer\.csv|invoice\.pdf|customer project|account owner/iu);
  });

  test('suppresses the current foreground conversation but not a different agent failure', async () => {
    const gateway = new RecordingNotificationGateway();
    const coordinator = new NotificationCoordinator(gateway);
    await coordinator.observe(state(), 'en', { visible: true, focused: true });

    await coordinator.observe(state({
      messages: [{
        id: 'foreground-reply', role: 'agent', targetAgentId: 'orchestrator', authorLabel: 'ORCHESTRATOR',
        text: 'visible answer', createdAt: '2026-08-28T10:00:00.000Z', evidenceLabel: null,
      }],
    }), 'en', { visible: true, focused: true });
    expect(gateway.notifications).toEqual([]);

    await coordinator.observe(state({
      executions: {
        native: {
          executionId: 'exec-native', projectId: previewSnapshot.project.id, targetAgentId: 'native',
          phase: 'failed', source: 'projection', summary: 'raw failure details',
          updatedAt: '2026-08-28T10:01:00.000Z', dispatchId: null, threadId: 'thread', turnId: 'turn',
          lastJournalSequence: 8, canInterrupt: false,
        },
      },
    }), 'en', { visible: true, focused: true });
    expect(gateway.notifications).toHaveLength(1);
    expect(gateway.notifications[0].body).not.toContain('raw failure details');
  });

  test('notifies a final reply from a non-selected conversation through the SQLite summary identity', async () => {
    const gateway = new RecordingNotificationGateway();
    const coordinator = new NotificationCoordinator(gateway);
    const baseline = state({
      historyConversations: [{
        targetAgentId: 'native', updatedAt: '2026-08-28T09:00:00.000Z',
        lastMessageId: 'native-old', lastRole: 'agent', preview: 'old private result',
      }],
    });
    await coordinator.observe({ ...baseline, userSignalsBaselineReady: false }, 'en', {
      visible: true, focused: true,
    });
    await coordinator.observe(baseline, 'en', { visible: true, focused: true });

    await coordinator.observe(state({
      historyConversations: [{
        targetAgentId: 'native', updatedAt: '2026-08-28T10:00:00.000Z',
        lastMessageId: 'native-new', lastRole: 'agent', preview: 'secret new result',
      }],
    }), 'en', { visible: true, focused: true });

    expect(gateway.notifications).toEqual([{
      title: 'New reply', body: 'A new reply is ready in Orquesta.',
    }]);
  });

  test('does not notify when a non-selected summary ends in a user or system message', async () => {
    const gateway = new RecordingNotificationGateway();
    const coordinator = new NotificationCoordinator(gateway);
    await coordinator.observe(state({ historyConversations: [] }), 'en', { visible: false, focused: false });

    for (const lastRole of ['user', 'system'] as const) {
      await coordinator.observe(state({
        historyConversations: [{
          targetAgentId: 'native', updatedAt: `2026-08-28T10:0${lastRole === 'user' ? '1' : '2'}:00.000Z`,
          lastMessageId: `native-${lastRole}`, lastRole, preview: 'not an agent reply',
        }],
      }), 'en', { visible: false, focused: false });
    }

    expect(gateway.notifications).toEqual([]);
  });

  test('does not catch up events observed while notifications were disabled', async () => {
    const gateway = new RecordingNotificationGateway();
    const coordinator = new NotificationCoordinator(gateway);
    const disabled = state({
      settings: {
        schemaVersion: 2, revision: 1, locale: 'en', theme: 'system',
        reducedMotion: false, notificationsEnabled: false, navigationCompact: true, workLedgerOpen: true,
      },
    });
    await coordinator.observe(disabled, 'en', { visible: false, focused: false });
    const disabledWithReply = {
      ...disabled,
      messages: [{
        id: 'disabled-reply', role: 'agent' as const, targetAgentId: 'orchestrator', authorLabel: 'ORCHESTRATOR',
        text: 'already seen', createdAt: '2026-08-28T10:00:00.000Z', evidenceLabel: null,
      }],
    };
    await coordinator.observe(disabledWithReply, 'en', { visible: false, focused: false });
    await coordinator.observe({
      ...disabledWithReply,
      settings: { ...disabled.settings!, revision: 2, notificationsEnabled: true },
    }, 'en', { visible: false, focused: false });

    expect(gateway.notifications).toEqual([]);
  });
});

describe('UserSignalTracker stream lifetime', () => {
  const signal = (key: string, streamKey: string): UserSignal => ({
    key,
    streamKey,
    cursor: `2026-08-28T10:00:00.000Z:${key}`,
    kind: 'final_reply',
    targetAgentId: 'orchestrator',
    announcement: key,
    notificationTitle: 'New reply',
    notificationBody: 'A new reply is ready in Orquesta.',
  });

  test('treats a newly added stream as live after the project baseline', () => {
    const tracker = new UserSignalTracker();
    tracker.observe([], ['conversation:project-a:orchestrator']);

    const addedStream = 'conversation:project-a:new-agent';
    expect(tracker.observe([signal('first-reply', addedStream)], [
      'conversation:project-a:orchestrator', addedStream,
    ])).toEqual([signal('first-reply', addedStream)]);
  });

  test('starts from a clean baseline after a project reset', () => {
    const tracker = new UserSignalTracker();
    const stream = 'conversation:project-a:orchestrator';
    tracker.observe([], [stream]);
    expect(tracker.observe([signal('new-a', stream)], [stream])).toEqual([signal('new-a', stream)]);

    tracker.reset();
    expect(tracker.observe([signal('existing-after-reset', stream)], [stream])).toEqual([]);
  });
});
