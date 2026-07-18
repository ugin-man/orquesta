import { describe, expect, test } from 'vitest';
import { isCoreEvent, isCoreRequest } from './protocol';

describe('Core protocol validation', () => {
  test('accepts ready and rejects a malformed ready event', () => {
    expect(isCoreEvent({ type: 'core.ready', version: 1 })).toBe(true);
    expect(isCoreEvent({ type: 'core.ready', version: '1' })).toBe(false);
  });

  test('accepts pong only with a non-empty correlation id', () => {
    expect(isCoreEvent({ type: 'core.pong', correlationId: 'ping-1' })).toBe(true);
    expect(isCoreEvent({ type: 'core.pong', correlationId: '' })).toBe(false);
  });

  test('accepts only bounded requests', () => {
    expect(isCoreRequest({ type: 'core.shutdown' })).toBe(true);
    expect(isCoreRequest({ type: 'core.ping', correlationId: 'ping-1' })).toBe(true);
    expect(isCoreRequest({ type: 'core.ping', correlationId: '' })).toBe(false);
    expect(isCoreRequest({ type: 'core.execute', command: 'whoami' })).toBe(false);
  });
});
