import type {
  SetupActivityUiModel,
  SetupPhaseUiModel,
  SetupTechnicalDetailUiModel
} from '../../../contracts/orquesta-ui';
import type { Locale } from '../i18n/messages';

const JAPANESE_TEXT = /[\u3040-\u30ff\u3400-\u9fff]/u;

const phaseCopy = {
  en: {
    environment: ['Environment', 'Confirm the selected project and required runtime.'],
    understanding: ['Project understanding', 'Read the project goals, structure, and key assets.'],
    foundation: ['Foundation', 'Prepare the state area and foundation agents.'],
    planning: ['Initial plan', 'Design the first milestone and executable work.'],
    specialists: ['Specialist team', 'Create the required specialists and role contracts.'],
    operation: ['Ready to operate', 'Confirm the initial team and open Home.']
  },
  ja: {
    environment: ['環境確認', 'プロジェクトとCodex実行環境を確認'],
    understanding: ['プロジェクト理解', '目的、構成、主要資料を整理'],
    foundation: ['基盤構築', '状態領域と基礎エージェントを準備'],
    planning: ['初期計画', '最初のマイルストーンを設計'],
    specialists: ['専門家編成', '必要な専門家と役割契約を作成'],
    operation: ['運用開始', '初期体制を確定してHomeへ移行']
  }
} as const;

type CanonicalPhaseId = keyof typeof phaseCopy.en;

const activityCopy: Record<string, { title: string; detail: string }> = {
  'foundation-agents': {
    title: 'Building the Orquesta foundation',
    detail: 'Creating the state area and role contracts for the foundation agents.'
  },
  'project-understanding': {
    title: 'Project understanding complete',
    detail: 'Read the project overview, manifest, and key design documents.'
  },
  'runtime-check': {
    title: 'Runtime confirmed',
    detail: 'Confirmed the Codex runtime and project write path.'
  },
  'initial-plan': {
    title: 'Create the initial plan',
    detail: 'Define the first milestone, required capabilities, and open questions.'
  },
  'operation-validation': {
    title: 'Confirming operational readiness',
    detail: 'Connecting the initial team and executable work before opening Home.'
  },
  'specialists-ready': {
    title: 'Specialist team complete',
    detail: 'Connected the required specialists and role contracts.'
  },
  'setup-environment-preflight': {
    title: 'Checking the environment',
    detail: 'Confirming the selected project and required runtime.'
  },
  'setup-environment-complete': {
    title: 'Environment check complete',
    detail: 'The selected project and required runtime are ready.'
  },
  'setup-understanding-complete': {
    title: 'Project understanding complete',
    detail: 'The project goals, structure, and key assets have been read.'
  },
  'setup-foundation-complete': {
    title: 'Foundation complete',
    detail: 'The state area and foundation agents are ready.'
  },
  'setup-planning-complete': {
    title: 'Initial plan complete',
    detail: 'The first milestone and executable work are ready.'
  },
  'setup-specialists-complete': {
    title: 'Specialist team complete',
    detail: 'The required specialists and role contracts are ready.'
  },
  'setup-operation-ready': {
    title: 'Checking operational readiness',
    detail: 'Confirming the initial team before opening Home.'
  },
  'setup-operation-complete': {
    title: 'Orquesta is ready',
    detail: 'Initial setup is complete and Home is ready to open.'
  },
  'setup-completed': {
    title: 'Initial setup complete',
    detail: 'Orquesta is ready to use.'
  },
  'setup-cancelled': {
    title: 'Initial setup stopped',
    detail: 'Progress was saved and can be resumed later.'
  },
  'setup-specialists-blocked': {
    title: 'Specialist setup needs attention',
    detail: 'Review the specialist setup before continuing.'
  }
};

export const setupCopy = {
  en: {
    mainLabel: 'Orquesta initial setup', phaseNav: 'Setup phases',
    phaseStatus: { complete: 'Complete', active: 'Running', waiting: 'Waiting', blocked: 'Stopped' },
    liveStatus: { complete: 'Complete', stopped: 'Stopped', running: 'Building' },
    setupFallback: 'Initial setup', progress: 'Progress', progressLabel: 'Setup progress',
    progressText: (current: number, total: number) => `Phase ${current} of ${total}`,
    systemLog: 'System log', nextPrefix: 'Next', recentProcesses: 'Recent setup activity',
    detailsOpen: 'Show technical details', detailsClose: 'Hide technical details',
    cancel: 'Stop setup', stageLabel: 'Pipe organ build status', stageKicker: 'MECHANICAL ORCHESTRATION / LOCAL SYSTEM',
    cancelTitle: 'Stop initial setup?', cancelBody: 'Your current progress will be saved. You can resume from this phase later.',
    cancelBack: 'Keep running', cancelConfirm: 'Stop setup',
    organStage: 'Setup mechanism', organLoading: 'Preparing the mechanism…',
    organAria: 'A pipe organ mechanism that starts as initial setup progresses',
    organFallbackTitle: 'Pipe organ mechanism',
    organFallbackBody: 'This view requires WebGL. Setup will continue normally.',
    connection: { connecting: 'Connecting', disconnected: 'Disconnected', connected: 'Connected' },
    mechanism: [
      'Starting the input mechanism', 'Transferring motion to the drive train',
      'Synchronizing mechanical control', 'Pressurizing the bellows and air reservoir',
      'Connecting airflow to the required pipes', 'Confirming all mechanisms are synchronized'
    ]
  },
  ja: {
    mainLabel: 'Orquesta 初回セットアップ', phaseNav: 'セットアップ段階',
    phaseStatus: { complete: '完了', active: '実行中', waiting: '待機', blocked: '停止' },
    liveStatus: { complete: '完了', stopped: '停止中', running: '構築中' },
    setupFallback: '初回セットアップ', progress: '進行状況', progressLabel: 'セットアップ進行状況',
    progressText: (current: number, total: number) => `${total}段階中${current}段階目`,
    systemLog: 'システムログ', nextPrefix: '次', recentProcesses: '直近のセットアップ処理',
    detailsOpen: '技術的な詳細を表示', detailsClose: '技術的な詳細を閉じる',
    cancel: 'セットアップを中止', stageLabel: 'パイプオルガン構築状況', stageKicker: 'MECHANICAL ORCHESTRATION / LOCAL SYSTEM',
    cancelTitle: 'セットアップを中止しますか', cancelBody: '現在の進行状況は保存されます。次回はこの段階から再開できます。',
    cancelBack: '中止せず戻る', cancelConfirm: 'セットアップを中止する',
    organStage: 'セットアップ機構', organLoading: '機構を準備しています…',
    organAria: '初回セットアップの進行に合わせて起動するパイプオルガン機構',
    organFallbackTitle: 'パイプオルガン機構', organFallbackBody: 'この表示にはWebGLが必要です。セットアップ処理はそのまま継続します。',
    connection: { connecting: '接続中', disconnected: '切断', connected: '接続済み' },
    mechanism: [
      '入力機構を始動しています', '動力列へ回転を伝えています', '機械制御を同期しています',
      'ベローズと空気槽を加圧しています', '必要なパイプへ空気経路を接続しています', '全機構の同期を確認しています'
    ]
  }
} as const;

export function getSetupCopy(locale: Locale) {
  return setupCopy[locale];
}

export function localizeSetupPhase(phase: SetupPhaseUiModel, locale: Locale): SetupPhaseUiModel {
  const copy = phaseCopy[locale][phase.id as CanonicalPhaseId];
  if (!copy) {
    if (locale === 'ja') return phase;
    return {
      ...phase,
      title: JAPANESE_TEXT.test(phase.title) ? `Phase ${phase.order}` : phase.title,
      summary: JAPANESE_TEXT.test(phase.summary) ? 'Preparing this setup phase.' : phase.summary
    };
  }
  return { ...phase, title: copy[0], summary: copy[1] };
}

function phaseActivityCopy(id: string): { title: string; detail: string } | null {
  const match = /^setup-(environment|understanding|foundation|planning|specialists|operation)-(active|blocked)$/u.exec(id);
  if (!match) return null;
  const phase = phaseCopy.en[match[1] as CanonicalPhaseId];
  return match[2] === 'blocked'
    ? { title: `${phase[0]} needs attention`, detail: `Review the ${phase[0].toLowerCase()} phase before continuing.` }
    : { title: `${phase[0]} in progress`, detail: phase[1] };
}

export function localizeSetupActivity(activity: SetupActivityUiModel, locale: Locale): SetupActivityUiModel {
  if (locale === 'ja') return activity;
  const copy = activityCopy[activity.id] ?? phaseActivityCopy(activity.id);
  if (copy) return { ...activity, ...copy };
  return {
    ...activity,
    title: JAPANESE_TEXT.test(activity.title) ? 'Setup activity' : activity.title,
    detail: JAPANESE_TEXT.test(activity.detail) ? 'Initial setup is continuing.' : activity.detail
  };
}

export function localizeTechnicalDetail(detail: SetupTechnicalDetailUiModel, locale: Locale): SetupTechnicalDetailUiModel {
  if (locale === 'ja') return detail;
  const labels: Record<string, string> = { runtime: 'Codex runtime', state: 'State area', journal: 'Setup journal', resume: 'Resume point' };
  const values: Record<string, string> = { '接続済み · App Server': 'Connected · App Server', '.orquesta を初期化中': 'Initializing .orquesta' };
  return {
    ...detail,
    label: labels[detail.id] ?? (JAPANESE_TEXT.test(detail.label) ? 'Setup detail' : detail.label),
    value: values[detail.value] ?? (JAPANESE_TEXT.test(detail.value) ? 'Setup in progress' : detail.value)
  };
}
