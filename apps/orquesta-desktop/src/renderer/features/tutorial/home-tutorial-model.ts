export const HOME_TUTORIAL_VERSION = 1 as const;
export const HOME_TUTORIAL_STORAGE_KEY = 'orquesta.desktop.home-tutorial.v1';

export type HomeTutorialStepId = 'map' | 'composer' | 'user-tasks' | 'now' | 'dock' | 'project' | 'luca';
export type HomeTutorialOutcome = 'completed' | 'skipped';
export type HomeTutorialLocaleCopy = {
  title: string;
  body: string;
  points?: readonly string[];
};
export type HomeTutorialStep = {
  id: HomeTutorialStepId;
  targetIds: readonly string[];
  copy: {
    ja: HomeTutorialLocaleCopy;
    en: HomeTutorialLocaleCopy;
  };
};
export type HomeTutorialPreference = {
  version: typeof HOME_TUTORIAL_VERSION;
  outcome: HomeTutorialOutcome;
  updatedAt: string;
};

export const HOME_TUTORIAL_STEPS: readonly HomeTutorialStep[] = [
  {
    id: 'map',
    targetIds: ['map'],
    copy: {
      ja: {
        title: 'Orquestaマップ',
        body: 'ここが現在の組織図です。統括者、専門家、チーム、生産ラインを一つの地図として表示し、待機中のエージェントも残ります。',
        points: ['選択して役割・状態・担当作業を確認', 'ドラッグで移動し、ホイールや上部ボタンで拡大', 'チーム管理は組織と一時監査の入口']
      },
      en: {
        title: 'Orquesta map',
        body: 'This is the live organization map. It shows the orchestrator, specialists, teams, and production lines while keeping idle agents visible.',
        points: ['Select an agent or task for details', 'Drag to pan and use the wheel or top controls to zoom', 'Team Management opens the roster and temporary inspections']
      }
    }
  },
  {
    id: 'composer',
    targetIds: ['composer'],
    copy: {
      ja: {
        title: '統括者への入力',
        body: 'Orquestaへ指示や質問を送る場所です。通常は統括者へ送り、必要な専門家への分配は統括者が行います。送信できたことと、タスクが完了したことは別です。'
      },
      en: {
        title: 'Message the orchestrator',
        body: 'Send instructions or questions here. The orchestrator routes work to specialists. A sent message confirms dispatch, not task completion.'
      }
    }
  },
  {
    id: 'user-tasks',
    targetIds: ['user-tasks'],
    copy: {
      ja: {
        title: 'ユーザータスク',
        body: '質問、承認、確認、手作業など、あなたの対応を待っている項目だけを表示します。回答済みや完了済みの項目はHomeへ残し続けません。'
      },
      en: {
        title: 'User Tasks',
        body: 'This area shows only items waiting for you: questions, approvals, reviews, and manual work. Completed items do not remain on Home.'
      }
    }
  },
  {
    id: 'now',
    targetIds: ['now'],
    copy: {
      ja: {
        title: '現在',
        body: '今まさに動いている、実行証拠のある作業を短く確認する場所です。未完了タスクのすべてや過去の履歴を並べる場所ではありません。'
      },
      en: {
        title: 'Now',
        body: 'See work that is actively running with execution evidence. This is not the full unfinished-task list or historical record.'
      }
    }
  },
  {
    id: 'dock',
    targetIds: ['dock'],
    copy: {
      ja: {
        title: '画面の切り替え',
        body: 'Homeは現在の全体像、ユーザータスクは自分の対応、記録はタスク・エラー・会話・判断・タイムライン、設定は表示・接続・起動・診断を扱います。',
        points: ['Home：現在の全体像', 'ユーザータスク：自分が対応する項目', '記録：タスク、エラー、会話、判断、タイムライン', '設定：表示、接続、起動、診断']
      },
      en: {
        title: 'Switch workspaces',
        body: 'Home shows the current overview. User Tasks holds your actions. Records contains tasks, failures, conversations, decisions, and the timeline. Settings covers display, connection, startup, and diagnostics.',
        points: ['Home: current overview', 'User Tasks: items awaiting you', 'Records: tasks, failures, conversation, decisions, and timeline', 'Settings: display, connection, startup, and diagnostics']
      }
    }
  },
  {
    id: 'project',
    targetIds: ['project-launcher', 'project-status'],
    copy: {
      ja: {
        title: 'Project操作と状態',
        body: '左上からProjectを切り替えたり、フォルダを開いたりできます。右上ではProject名、エージェント数、接続状態を確認できます。'
      },
      en: {
        title: 'Project controls and status',
        body: 'Use the top-left control to switch projects or open the folder. The top-right card shows the project name, agent count, and connection state.'
      }
    }
  },
  {
    id: 'luca',
    targetIds: ['luca'],
    copy: {
      ja: {
        title: 'Lucaに聞く',
        body: '何が起きているか分からないときはLucaへ聞けます。Lucaは現在の記録を説明する役であり、質問しただけでタスクや組織を変更しません。'
      },
      en: {
        title: 'Ask Luca',
        body: 'Ask Luca when the current state is unclear. Luca explains the available records and does not change tasks or the organization just because you asked.'
      }
    }
  }
];

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function readHomeTutorialPreference(storage: Storage): HomeTutorialPreference | null {
  const raw = storage.getItem(HOME_TUTORIAL_STORAGE_KEY);
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<HomeTutorialPreference>;
    if (
      value.version !== HOME_TUTORIAL_VERSION
      || (value.outcome !== 'completed' && value.outcome !== 'skipped')
      || !isIsoTimestamp(value.updatedAt)
    ) {
      return null;
    }
    return value as HomeTutorialPreference;
  } catch {
    return null;
  }
}

export function writeHomeTutorialPreference(
  storage: Storage,
  outcome: HomeTutorialOutcome,
  now = new Date()
): void {
  const preference: HomeTutorialPreference = {
    version: HOME_TUTORIAL_VERSION,
    outcome,
    updatedAt: now.toISOString()
  };
  storage.setItem(HOME_TUTORIAL_STORAGE_KEY, JSON.stringify(preference));
}

type SetupStatus = 'preparing' | 'running' | 'paused' | 'blocked' | 'completed' | 'cancelled';
const ACTIVE_SETUP_STATUSES: readonly SetupStatus[] = ['preparing', 'running', 'paused', 'blocked'];

export function shouldAutoStartHomeTutorial(
  previousStatus: SetupStatus | null | undefined,
  nextStatus: SetupStatus | null | undefined,
  preference: HomeTutorialPreference | null
): boolean {
  return nextStatus === 'completed'
    && previousStatus != null
    && ACTIVE_SETUP_STATUSES.includes(previousStatus)
    && preference == null;
}
