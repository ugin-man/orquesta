import type { SetupUiSnapshot } from '../contracts/orquesta-ui';
import { activeProjectFixture } from './active-project';
import type { FixtureDefinition } from './types';

const setup: SetupUiSnapshot = {
  status: 'running',
  projectTitle: 'Orquesta Desktop',
  projectRootLabel: 'C:\\Users\\kouki\\OneDrive\\ドキュメント\\Orquesta',
  currentPhaseId: 'foundation',
  startedAt: '2026-07-20T08:00:00.000Z',
  updatedAt: '2026-07-20T08:01:30.000Z',
  phases: [
    { id: 'environment', order: 1, title: '環境確認', summary: 'プロジェクトとCodex実行環境を確認', status: 'complete' },
    { id: 'understanding', order: 2, title: 'プロジェクト理解', summary: '目的、構成、主要資料を整理', status: 'complete' },
    { id: 'foundation', order: 3, title: '基盤構築', summary: '状態領域と基礎エージェントを準備', status: 'active' },
    { id: 'planning', order: 4, title: '初期計画', summary: '最初のマイルストーンを設計', status: 'waiting' },
    { id: 'specialists', order: 5, title: '専門家編成', summary: '必要な専門家と役割契約を作成', status: 'waiting' },
    { id: 'operation', order: 6, title: '運用開始', summary: '初期体制を確定してHomeへ移行', status: 'waiting' }
  ],
  currentActivity: {
    id: 'foundation-agents',
    title: 'Orquestaの基盤を構築しています',
    detail: '統括者、利用者支援係、管理係の役割契約と状態領域を構築しています。',
    status: 'active',
    observedAt: '2026-07-20T08:01:30.000Z'
  },
  recentActivities: [
    {
      id: 'project-understanding',
      title: 'プロジェクト理解を完了',
      detail: 'README、マニフェスト、主要設計書から現在地と最初の成果を整理しました。',
      status: 'complete',
      observedAt: '2026-07-20T08:01:08.000Z'
    },
    {
      id: 'runtime-check',
      title: '実行環境を確認',
      detail: 'Codex runtimeとプロジェクトへの書き込み経路を確認しました。',
      status: 'complete',
      observedAt: '2026-07-20T08:00:31.000Z'
    }
  ],
  nextActivity: {
    id: 'initial-plan',
    title: '初期計画を作成',
    detail: '最初のマイルストーン、必要能力、未確認事項を整理します。',
    status: 'waiting',
    observedAt: null
  },
  technicalDetails: [
    { id: 'runtime', label: 'Codex runtime', value: '接続済み · App Server', tone: 'success' },
    { id: 'state', label: '状態領域', value: '.orquesta を初期化中', tone: 'warning' },
    { id: 'journal', label: 'Setup journal', value: '.orquesta/setup/session.json', tone: 'neutral' },
    { id: 'resume', label: '再開地点', value: 'phase 3 · foundation', tone: 'neutral' }
  ],
  canCancel: true
};

export const setupRunningFixture: FixtureDefinition = {
  ...activeProjectFixture,
  snapshot: {
    ...activeProjectFixture.snapshot,
    project: {
      ...activeProjectFixture.snapshot.project,
      id: 'setup-running',
      title: 'Orquesta Desktop',
      connectionLabel: '初回セットアップ実行中',
      currentPhaseId: null,
      summary: '初回セットアップのレビュー状態',
      nextMilestone: '初回セットアップ画面のユーザーレビュー'
    },
    setup
  }
};

export const setupOperationFixture: FixtureDefinition = {
  ...setupRunningFixture,
  snapshot: {
    ...setupRunningFixture.snapshot,
    project: {
      ...setupRunningFixture.snapshot.project,
      id: 'setup-operation',
      connectionLabel: '初回セットアップ最終確認中',
      summary: '初期体制の同期を確認しています'
    },
    setup: {
      ...setup,
      currentPhaseId: 'operation',
      updatedAt: '2026-07-20T08:04:30.000Z',
      phases: setup.phases.map((phase) => ({
        ...phase,
        status: phase.id === 'operation' ? 'active' : 'complete'
      })),
      currentActivity: {
        id: 'operation-validation',
        title: '運用開始を確認しています',
        detail: '基礎エージェント、専門家、最初の実行可能作業を接続し、Homeへ移行できる状態を確認しています。',
        status: 'active',
        observedAt: '2026-07-20T08:04:30.000Z'
      },
      recentActivities: [
        ...setup.recentActivities,
        {
          id: 'specialists-ready',
          title: '専門家編成を完了',
          detail: '必要な専門家と役割契約を初期体制へ接続しました。',
          status: 'complete',
          observedAt: '2026-07-20T08:04:12.000Z'
        }
      ],
      nextActivity: null,
      technicalDetails: setup.technicalDetails.map((detail) => (
        detail.id === 'resume' ? { ...detail, value: 'phase 6 · operation' } : detail
      ))
    }
  }
};
