export const LUCA_AGENT_ID = 'orquesta-admin' as const;
export const LUCA_DISPLAY_NAME = 'Luca' as const;
export const LUCA_ROLE_LABEL = 'プロジェクト説明係' as const;
export const LUCA_ROLE_SUMMARY = 'Orquestaの記録を読み取り、ユーザーの質問へ短く説明する読み取り専用の質問係。' as const;

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
