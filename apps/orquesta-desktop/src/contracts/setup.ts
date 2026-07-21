export const SETUP_PHASE_IDS = [
  'environment',
  'understanding',
  'foundation',
  'planning',
  'specialists',
  'operation'
] as const;

export type SetupPhaseId = typeof SETUP_PHASE_IDS[number];

export type SetupSourceDraft =
  | { kind: 'detected_root'; rootPath: string }
  | { kind: 'existing_folder'; rootPath: string }
  | { kind: 'new_project'; parentPath: string; folderName: string }
  | { kind: 'public_github'; repositoryUrl: string; parentPath: string };

export interface SetupQuestion {
  questionId: string;
  prompt: string;
  required: false;
}

export interface SetupAnswer {
  questionId: string;
  answer: string;
}

export interface SetupDraft {
  revision: 1;
  status: 'draft';
  source: SetupSourceDraft;
  projectName: string;
  description: string;
  questions: SetupQuestion[];
  answers: SetupAnswer[];
}

export type SetupAccountState =
  | { status: 'checking'; accountType: null; requiresOpenaiAuth: null }
  | { status: 'authenticated'; accountType: 'chatgpt' | 'api_key'; requiresOpenaiAuth: boolean }
  | { status: 'unauthenticated'; accountType: null; requiresOpenaiAuth: boolean }
  | { status: 'unavailable'; accountType: null; requiresOpenaiAuth: null; reason: string };

export interface SetupLoginStartResult {
  type: 'chatgpt' | 'chatgpt_device_code';
  loginId: string;
  authUrl: string | null;
}

export interface SetupStartInput {
  rootPath: string;
  draft: SetupDraft;
}

export interface SetupStartResult {
  setupId: string;
  rootPath: string;
  activePhaseId: SetupPhaseId;
}

export interface SetupProgressEvent {
  setupId: string;
  phaseId: SetupPhaseId;
  status: 'queued' | 'active' | 'completed' | 'failed';
  message: string;
  occurredAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0);
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/u.test(value);
}

function isFolderName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && value !== '.'
    && value !== '..'
    && !/[<>:"/\\|?*\u0000-\u001f]/u.test(value)
    && !/[. ]$/u.test(value);
}

function isPublicGitHubUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'github.com'
      && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/u.test(url.pathname)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function isSetupSourceDraft(value: unknown): value is SetupSourceDraft {
  if (!isRecord(value)) return false;
  if (value.kind === 'detected_root' || value.kind === 'existing_folder') {
    return isString(value.rootPath, 32_768);
  }
  if (value.kind === 'new_project') {
    return isString(value.parentPath, 32_768) && isFolderName(value.folderName);
  }
  if (value.kind === 'public_github') {
    return isPublicGitHubUrl(value.repositoryUrl) && isString(value.parentPath, 32_768);
  }
  return false;
}

function isSetupQuestion(value: unknown): value is SetupQuestion {
  return isRecord(value)
    && isSafeId(value.questionId)
    && isString(value.prompt, 2_048)
    && value.required === false;
}

function isSetupAnswer(value: unknown): value is SetupAnswer {
  return isRecord(value)
    && isSafeId(value.questionId)
    && isString(value.answer, 8_192, true);
}

export function isSetupDraft(value: unknown): value is SetupDraft {
  if (!isRecord(value)) return false;
  if (value.revision !== 1 || value.status !== 'draft' || !isSetupSourceDraft(value.source)) return false;
  if (!isString(value.projectName, 128) || !isString(value.description, 16_384, true)) return false;
  if (!Array.isArray(value.questions) || value.questions.length > 3 || !value.questions.every(isSetupQuestion)) return false;
  if (!Array.isArray(value.answers) || value.answers.length > 3 || !value.answers.every(isSetupAnswer)) return false;
  const questionIds = new Set(value.questions.map((question) => question.questionId));
  const answerIds = value.answers.map((answer) => answer.questionId);
  return new Set(answerIds).size === answerIds.length && answerIds.every((questionId) => questionIds.has(questionId));
}

export function parseSetupDraft(value: unknown): SetupDraft {
  if (!isSetupDraft(value)) throw new TypeError('Invalid setup draft');
  return structuredClone(value);
}

export function isSetupPhaseId(value: unknown): value is SetupPhaseId {
  return typeof value === 'string' && SETUP_PHASE_IDS.includes(value as SetupPhaseId);
}

export function isSetupAccountState(value: unknown): value is SetupAccountState {
  if (!isRecord(value)) return false;
  if (value.status === 'checking') return value.accountType === null && value.requiresOpenaiAuth === null;
  if (value.status === 'authenticated') {
    return ['chatgpt', 'api_key'].includes(String(value.accountType)) && typeof value.requiresOpenaiAuth === 'boolean';
  }
  if (value.status === 'unauthenticated') return value.accountType === null && typeof value.requiresOpenaiAuth === 'boolean';
  return value.status === 'unavailable'
    && value.accountType === null
    && value.requiresOpenaiAuth === null
    && isString(value.reason, 2_048);
}

export function isSetupProgressEvent(value: unknown): value is SetupProgressEvent {
  if (!isRecord(value)) return false;
  return isSafeId(value.setupId)
    && isSetupPhaseId(value.phaseId)
    && ['queued', 'active', 'completed', 'failed'].includes(String(value.status))
    && isString(value.message, 2_048)
    && typeof value.occurredAt === 'string'
    && Number.isFinite(Date.parse(value.occurredAt));
}
