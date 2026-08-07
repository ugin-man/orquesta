export interface SetupLaunchIntent {
  source: 'argv' | 'environment' | 'e2e';
  rootPath: string;
  callingThreadId: string | null;
  legacyMigration?: boolean;
}

interface SetupLaunchIntentInput {
  argv: string[];
  env: Pick<NodeJS.ProcessEnv, 'ORQUESTA_PROJECT_ROOT' | 'ORQUESTA_E2E' | 'ORQUESTA_E2E_PROJECT_ROOT' | 'CODEX_THREAD_ID'>;
  cwd: string;
}

function boundedRoot(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 32_768 ? value : null;
}

function argvRoot(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--orquesta-project') return boundedRoot(argv[index + 1]);
    if (argument.startsWith('--orquesta-project=')) return boundedRoot(argument.slice('--orquesta-project='.length));
  }
  return null;
}

function boundedThreadId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/u.test(value.trim())
    ? value.trim()
    : null;
}

function argvThreadId(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--orquesta-calling-thread') return boundedThreadId(argv[index + 1]);
    if (argument.startsWith('--orquesta-calling-thread=')) {
      return boundedThreadId(argument.slice('--orquesta-calling-thread='.length));
    }
  }
  return null;
}

function argvLegacyMigration(argv: string[]): boolean {
  return argv.includes('--orquesta-migrate-legacy-runtime');
}

export function resolveSetupLaunchIntent(input: SetupLaunchIntentInput): SetupLaunchIntent | null {
  const explicit = argvRoot(input.argv);
  if (explicit) {
    return {
      source: 'argv',
      rootPath: explicit,
      callingThreadId: argvThreadId(input.argv) ?? boundedThreadId(input.env.CODEX_THREAD_ID),
      ...(argvLegacyMigration(input.argv) ? { legacyMigration: true } : {})
    };
  }
  const e2e = input.env.ORQUESTA_E2E === '1' ? boundedRoot(input.env.ORQUESTA_E2E_PROJECT_ROOT) : null;
  if (e2e) return { source: 'e2e', rootPath: e2e, callingThreadId: null };
  const environment = boundedRoot(input.env.ORQUESTA_PROJECT_ROOT);
  if (environment) {
    return {
      source: 'environment',
      rootPath: environment,
      callingThreadId: boundedThreadId(input.env.CODEX_THREAD_ID)
    };
  }
  return null;
}
