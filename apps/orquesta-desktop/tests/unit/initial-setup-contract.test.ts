import { describe, expect, test } from 'vitest';
import { isSetupUiSnapshot, type SetupUiSnapshot } from '../../src/contracts/orquesta-ui';
import { fixtureCatalog } from '../../src/fixtures';
import type { FixtureDefinition } from '../../src/fixtures/types';

const setup: SetupUiSnapshot = {
  status: 'running',
  projectTitle: 'Orquesta Desktop',
  projectRootLabel: 'C:\\projects\\orquesta',
  currentPhaseId: 'foundation',
  startedAt: '2026-07-20T08:00:00.000Z',
  updatedAt: '2026-07-20T08:01:30.000Z',
  phases: [
    { id: 'environment', order: 1, title: '環境確認', summary: '実行環境を確認します', status: 'complete' },
    { id: 'understanding', order: 2, title: 'プロジェクト理解', summary: '主要資料を読みます', status: 'complete' },
    { id: 'foundation', order: 3, title: '基盤構築', summary: '状態領域を作ります', status: 'active' },
    { id: 'planning', order: 4, title: '初期計画', summary: '最初の計画を作ります', status: 'waiting' },
    { id: 'specialists', order: 5, title: '専門家編成', summary: '必要な専門家を作ります', status: 'waiting' },
    { id: 'launch', order: 6, title: '運用開始', summary: '通常運用へ移ります', status: 'waiting' }
  ],
  currentActivity: {
    id: 'activity-foundation',
    title: 'Orquestaの基盤を構築中',
    detail: '状態領域と三体の基礎エージェントを準備しています。',
    status: 'active',
    observedAt: '2026-07-20T08:01:30.000Z'
  },
  recentActivities: [{
    id: 'activity-understanding',
    title: 'プロジェクト理解を完了',
    detail: 'READMEと主要設計書を確認しました。',
    status: 'complete',
    observedAt: '2026-07-20T08:01:00.000Z'
  }],
  nextActivity: {
    id: 'activity-plan',
    title: '初期計画を作成',
    detail: '最初のマイルストーンと必要能力を整理します。',
    status: 'waiting',
    observedAt: null
  },
  technicalDetails: [
    { id: 'runtime', label: 'Codex runtime', value: '接続済み', tone: 'success' },
    { id: 'journal', label: 'Setup journal', value: '.orquesta/setup/session.json', tone: 'neutral' }
  ],
  canCancel: true
};

describe('initial setup UI contract', () => {
  test('accepts one active phase in a six-stage setup snapshot', () => {
    expect(isSetupUiSnapshot(setup)).toBe(true);
  });

  test('rejects setup state without all six ordered phases', () => {
    expect(isSetupUiSnapshot({ ...setup, phases: setup.phases.slice(0, 5) })).toBe(false);
  });

  test('rejects setup state with more than one active phase', () => {
    expect(isSetupUiSnapshot({
      ...setup,
      phases: setup.phases.map((phase) => phase.id === 'planning' ? { ...phase, status: 'active' as const } : phase)
    })).toBe(false);
  });

  test('provides a six-stage phase-three review fixture', () => {
    const fixture = (fixtureCatalog as Record<string, FixtureDefinition>)['setup-running'];
    expect(fixture).toBeDefined();
    expect(fixture.snapshot.setup?.phases).toHaveLength(6);
    expect(fixture.snapshot.setup?.currentPhaseId).toBe('foundation');
    expect(fixture.snapshot.setup?.phases.find((phase) => phase.status === 'active')?.order).toBe(3);
    expect(isSetupUiSnapshot(fixture.snapshot.setup)).toBe(true);
  });
});
