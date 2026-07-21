export interface SetupLaunchIntent {
  source: 'argv' | 'environment' | 'e2e';
  rootPath: string;
}

interface SetupLaunchIntentInput {
  argv: string[];
  env: Pick<NodeJS.ProcessEnv, 'ORQUESTA_PROJECT_ROOT' | 'ORQUESTA_E2E' | 'ORQUESTA_E2E_PROJECT_ROOT'>;
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

export function resolveSetupLaunchIntent(input: SetupLaunchIntentInput): SetupLaunchIntent | null {
  const explicit = argvRoot(input.argv);
  if (explicit) return { source: 'argv', rootPath: explicit };
  const e2e = input.env.ORQUESTA_E2E === '1' ? boundedRoot(input.env.ORQUESTA_E2E_PROJECT_ROOT) : null;
  if (e2e) return { source: 'e2e', rootPath: e2e };
  const environment = boundedRoot(input.env.ORQUESTA_PROJECT_ROOT);
  if (environment) return { source: 'environment', rootPath: environment };
  return null;
}
