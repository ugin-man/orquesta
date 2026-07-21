export const LUCA_AGENT_ID = 'orquesta-admin' as const;
export const LUCA_DISPLAY_NAME = 'Luca' as const;
export const LUCA_ROLE_LABEL = 'プロジェクト説明係' as const;
export const LUCA_ROLE_SUMMARY = 'Orquestaの記録を読み取り、ユーザーの質問へ短く説明する読み取り専用の質問係。' as const;

export const LUCA_QUESTION_IDS = [
  'task.explain', 'task.outcome', 'task.important', 'task.custom',
  'failure.explain', 'failure.cause-impact', 'failure.recovery', 'failure.custom',
  'inspection.explain', 'inspection.key-finding', 'inspection.evidence', 'inspection.custom',
  'home.custom', 'home.current', 'home.active', 'home.blocked', 'home.completed', 'home.next',
  'home.user-review', 'home.user-answer', 'home.user-decision', 'home.overlooked', 'home.project',
  'home.phase', 'home.changed', 'home.organization', 'home.health', 'home.recent-errors',
  'home.repeated', 'home.bottleneck'
] as const;

export type LucaQuestionId = typeof LUCA_QUESTION_IDS[number];
export type LucaContextKind = 'home' | 'task' | 'failure' | 'inspection';
export type LucaContextRef =
  | { kind: 'home' }
  | { kind: Exclude<LucaContextKind, 'home'>; id: string };

export interface AskLucaInput {
  questionId: LucaQuestionId;
  context: LucaContextRef;
  locale: 'ja' | 'en';
  customText?: string | null;
}

export interface LucaReference {
  kind: 'project' | 'phase' | 'task' | 'failure' | 'inspection' | 'agent' | 'attention';
  id: string;
  label: string;
}

export interface LucaAnswerPayload {
  answer: string;
  points: string[];
  uncertainties: string[];
  references: LucaReference[];
}
