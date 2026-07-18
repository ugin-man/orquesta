import type { CoreEvent } from './protocol';
import { handleCoreRequest } from './handler';

const parentPort = process.parentPort;

if (!parentPort) {
  throw new Error('Orquesta Core must run as an Electron utility process');
}

const send = (event: CoreEvent) => parentPort.postMessage(event);
const stop = () => {
  send({ type: 'core.stopped' });
  setImmediate(() => process.exit(0));
};

parentPort.on('message', (event) => {
  handleCoreRequest(event.data, { send, stop });
});

send({ type: 'core.ready', version: 1 });
