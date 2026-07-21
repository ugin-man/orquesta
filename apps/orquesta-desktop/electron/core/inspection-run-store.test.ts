import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  inspectionReportPath,
  readInspectionState,
  writeInspectionState,
  type InspectionRunRecord
} from './inspection-run-store';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-inspection-store-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, '.orquesta', 'state'), { recursive: true });
  return root;
}

function runningRun(): InspectionRunRecord {
  return {
    runId: 'inspection-001',
    kind: 'external_benchmark',
    requestedBy: 'user',
    target: { kind: 'project', ids: [] },
    focus: null,
    status: 'running',
    threadId: 'thread-001',
    turnId: 'turn-001',
    reportPath: null,
    sourceCount: 0,
    errorCode: null,
    errorMessage: null,
    runtimeBoundary: {
      sandbox: 'read-only',
      approvalPolicy: 'never',
      webSearchMode: 'live'
    },
    createdAt: '2026-07-21T00:00:00.000Z',
    startedAt: '2026-07-21T00:00:01.000Z',
    completedAt: null,
    closedAt: null
  };
}

describe('inspection run store', () => {
  test('returns an empty versioned state when the state file is absent', async () => {
    const root = await temporaryProject();
    await expect(readInspectionState(root)).resolves.toEqual({ version: 1, runs: [] });
  });

  test('writes versioned state atomically and reads it back', async () => {
    const root = await temporaryProject();
    const state = { version: 1 as const, runs: [runningRun()] };

    await writeInspectionState(root, state);

    await expect(readInspectionState(root)).resolves.toEqual(state);
  });

  test('rejects a report path that uses an unsafe run id', async () => {
    const root = await temporaryProject();
    await expect(inspectionReportPath(root, '../escape')).rejects.toThrow(/run id/i);
  });
});
