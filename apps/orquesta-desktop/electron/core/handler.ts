import type { CoreDispatchRequest, CoreEvent } from './protocol';
import { isCoreRequest } from './protocol';

export interface CoreRequestHandlers {
  send(event: CoreEvent): void;
  dispatch(request: CoreDispatchRequest): void;
  stop(): void;
}

export function handleCoreRequest(message: unknown, handlers: CoreRequestHandlers): boolean {
  if (!isCoreRequest(message)) return false;
  if (message.type === 'core.ping') {
    handlers.send({ type: 'core.pong', correlationId: message.correlationId });
    return true;
  }
  if (message.type !== 'core.shutdown') {
    handlers.dispatch(message);
    return true;
  }
  handlers.stop();
  return true;
}
