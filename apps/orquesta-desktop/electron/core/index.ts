import type { CoreEvent } from './protocol';
import { handleCoreRequest } from './handler';
import { AppServerClient } from './app-server-client';
import { CodexRuntime } from './codex-runtime';
import { discoverCodexExecutable } from './codex-executable';

const parentPort = process.parentPort;

if (!parentPort) {
  throw new Error('Orquesta Core must run as an Electron utility process');
}

const send = (event: CoreEvent) => parentPort.postMessage(event);
let runtimePromise: Promise<CodexRuntime> | null = null;

async function runtime(): Promise<CodexRuntime> {
  if (!runtimePromise) {
    runtimePromise = discoverCodexExecutable().then((executablePath) => {
      const e2eScript = process.env.ORQUESTA_E2E === '1' ? process.env.ORQUESTA_E2E_CODEX_SCRIPT : null;
      const instance = new CodexRuntime(new AppServerClient({ executablePath, argsPrefix: e2eScript ? [e2eScript] : [] }));
      instance.subscribe((notification) => send({ type: 'runtime.notification', notification }));
      return instance;
    }).catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

const stop = () => {
  void (async () => {
    const instance = runtimePromise ? await runtimePromise.catch(() => null) : null;
    await instance?.stop().catch(() => undefined);
    send({ type: 'core.stopped' });
    setImmediate(() => process.exit(0));
  })();
};

const dispatch = (request: Extract<import('./protocol').CoreRequest, { type: 'runtime.send' | 'runtime.conversation' }>) => {
  void (async () => {
    try {
      const instance = await runtime();
      if (request.type === 'runtime.send') {
        const result = await instance.sendMessage(request);
        send({ type: 'runtime.dispatch.accepted', correlationId: request.correlationId, ...result });
      } else {
        const page = await instance.listConversation(request);
        send({ type: 'runtime.conversation.result', correlationId: request.correlationId, page });
      }
    } catch (error) {
      send({
        type: 'runtime.request.failed', correlationId: request.correlationId,
        reason: error instanceof Error ? error.message.slice(0, 4_096) : String(error).slice(0, 4_096), retryable: true
      });
    }
  })();
};

parentPort.on('message', (event) => {
  handleCoreRequest(event.data, { send, stop, dispatch });
});

send({ type: 'core.ready', version: 1 });
