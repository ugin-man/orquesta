export function useFakeRuntimeCore(env: Pick<NodeJS.ProcessEnv, 'ORQUESTA_E2E' | 'ORQUESTA_E2E_CODEX_SCRIPT'>): boolean {
  return env.ORQUESTA_E2E === '1' && Boolean(env.ORQUESTA_E2E_CODEX_SCRIPT);
}
