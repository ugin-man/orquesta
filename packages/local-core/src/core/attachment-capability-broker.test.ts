import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import {
  ATTACHMENT_SOURCE_BYTES_PER_CALL,
  ATTACHMENT_WIRE_BYTES_PER_CALL,
  ATTACHMENT_TOOL_NAME,
  AttachmentCapabilityBroker,
  providerAttachmentGuide,
  type DispatchPrivateAttachment
} from './attachment-capability-broker';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function textAttachment(content: string, displayName = '資料.txt', mediaType = 'text/plain'): Promise<{
  attachment: DispatchPrivateAttachment;
  base: string;
  sealedRoot: string;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'orquesta-attachment-broker-'));
  roots.push(base);
  const sealedRoot = path.join(base, 'sealed');
  await mkdir(sealedRoot);
  const attachmentStoreHandle = randomUUID();
  const sealedAbsolutePath = path.join(sealedRoot, attachmentStoreHandle);
  const bytes = Buffer.from(content, 'utf8');
  await writeFile(sealedAbsolutePath, bytes, { flag: 'wx' });
  return {
    base,
    sealedRoot,
    attachment: {
      attachmentStoreHandle,
      kind: 'text',
      displayName,
      mediaType,
      sealedAbsolutePath,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      encoding: 'utf-8'
    }
  };
}

async function preparedText(content: string, displayName = '資料.txt') {
  const fixture = await textAttachment(content, displayName);
  const broker = new AttachmentCapabilityBroker();
  await broker.selectSealedRoot(fixture.sealedRoot);
  const prepared = await broker.prepareDispatch([fixture.attachment]);
  return { ...fixture, broker, prepared };
}

const scope = {
  providerConnectionId: 'provider-1',
  correlationId: 'correlation-1',
  threadId: 'thread-1',
  turnId: 'turn-1'
};

function request(capability: string, cursor: string | null) {
  return {
    method: 'item/tool/call',
    tool: ATTACHMENT_TOOL_NAME,
    arguments: { capability, cursor }
  };
}

function payload(result: Awaited<ReturnType<ReturnType<AttachmentCapabilityBroker['bindTurn']>['handle']>>) {
  return JSON.parse(result.response.contentItems[0].text) as {
    content: string;
    nextCursor: string | null;
    nextLine: number;
    eof: boolean;
  };
}

test('reads a 512 KiB long line through opaque UTF-8 cursors within all fixed budgets', async () => {
  const content = `${'あ'.repeat(174_000)}${'x'.repeat(2_288)}`;
  expect(Buffer.byteLength(content, 'utf8')).toBe(512 * 1024);
  const { broker, prepared } = await preparedText(content);
  const capability = prepared.textAttachments[0].capability;
  const handler = broker.bindTurn(prepared, scope);
  let cursor: string | null = null;
  let reconstructed = '';
  let calls = 0;
  do {
    const result = await handler.handle(request(capability, cursor));
    expect(result.response.success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.response), 'utf8')).toBeLessThanOrEqual(ATTACHMENT_WIRE_BYTES_PER_CALL);
    const chunk = payload(result);
    expect(Buffer.byteLength(chunk.content, 'utf8')).toBeLessThanOrEqual(ATTACHMENT_SOURCE_BYTES_PER_CALL);
    reconstructed += chunk.content;
    cursor = chunk.nextCursor;
    calls += 1;
    expect(calls).toBeLessThanOrEqual(128);
  } while (cursor !== null);
  expect(calls).toBe(65);
  expect(reconstructed).toBe(content);
});

test('allows only one of two concurrent calls using the same initial cursor', async () => {
  const { broker, prepared } = await preparedText('one\ntwo\n');
  const capability = prepared.textAttachments[0].capability;
  const handler = broker.bindTurn(prepared, scope);
  const results = await Promise.all([
    handler.handle(request(capability, null)),
    handler.handle(request(capability, null))
  ]);
  expect(results.filter((result) => result.response.success)).toHaveLength(1);
  expect(results.filter((result) => !result.response.success)).toHaveLength(1);
});

test('poisons a capability after response write loss without disclosing private identity', async () => {
  const content = `${'\\"\u0001\n'.repeat(2_500)}tail`;
  const { attachment, broker, prepared } = await preparedText(content, 'quoted file.txt');
  const capability = prepared.textAttachments[0].capability;
  const handler = broker.bindTurn(prepared, scope);
  const first = await handler.handle(request(capability, null));
  const firstPayload = payload(first);
  expect(first.response.success).toBe(true);
  const serialized = JSON.stringify(first.response);
  expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(ATTACHMENT_WIRE_BYTES_PER_CALL);
  expect(serialized).not.toContain(attachment.sealedAbsolutePath);
  expect(serialized).not.toContain(attachment.sha256);
  expect(serialized).not.toContain(attachment.attachmentStoreHandle);
  first.onResponseWriteFailure();
  expect(firstPayload.nextCursor).not.toBeNull();
  const retry = await handler.handle(request(capability, firstPayload.nextCursor));
  expect(retry.response.success).toBe(false);
});

test('actively aborts a deadline-bound read and never reuses its consumed cursor', async () => {
  const { attachment, sealedRoot } = await textAttachment('deadline');
  let aborted = false;
  const broker = new AttachmentCapabilityBroker({
    deadlineMs: 25,
    beforeRead: (_attachment, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    })
  });
  await broker.selectSealedRoot(sealedRoot);
  const prepared = await broker.prepareDispatch([attachment]);
  const capability = prepared.textAttachments[0].capability;
  const handler = broker.bindTurn(prepared, scope);
  const started = Date.now();
  const timedOut = await handler.handle(request(capability, null));
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(aborted).toBe(true);
  expect(timedOut.response.success).toBe(false);
  expect((await handler.handle(request(capability, null))).response.success).toBe(false);
});

test('hard deadline settles and poisons a cursor when an operation ignores the abort signal forever', async () => {
  const { attachment, sealedRoot } = await textAttachment('ignored deadline abort');
  const broker = new AttachmentCapabilityBroker({
    deadlineMs: 25,
    beforeRead: async () => { await new Promise<void>(() => {}); }
  });
  await broker.selectSealedRoot(sealedRoot);
  const prepared = await broker.prepareDispatch([attachment]);
  const capability = prepared.textAttachments[0].capability;
  const handler = broker.bindTurn(prepared, scope);
  const started = Date.now();
  const result = await handler.handle(request(capability, null));
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(result.response.success).toBe(false);
  expect((await handler.handle(request(capability, null))).response.success).toBe(false);
});

test('terminal expiry quiesces even when an in-flight operation ignores its abort signal forever', async () => {
  const { attachment, sealedRoot } = await textAttachment('ignored abort');
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const broker = new AttachmentCapabilityBroker({
    deadlineMs: 25,
    beforeRead: async () => {
      entered();
      await new Promise<void>(() => {});
    }
  });
  await broker.selectSealedRoot(sealedRoot);
  const prepared = await broker.prepareDispatch([attachment]);
  const capability = prepared.textAttachments[0].capability;
  const handler = broker.bindTurn(prepared, scope);
  const started = Date.now();
  const inFlight = handler.handle(request(capability, null));
  await enteredPromise;
  const terminal = handler.expire('turn_terminal');
  const [result] = await Promise.all([inFlight, terminal]);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(result.response.success).toBe(false);
  expect((await handler.handle(request(capability, null))).response.success).toBe(false);
});

test('expires every exact-turn capability before a later tool request can read', async () => {
  const { broker, prepared } = await preparedText('terminal');
  const capability = prepared.textAttachments[0].capability;
  const handler = broker.bindTurn(prepared, scope);
  await handler.expire('turn_terminal');
  expect((await handler.handle(request(capability, null))).response.success).toBe(false);
});

test('aborts and quiesces an in-flight read before terminal expiry resolves without affecting a sibling turn', async () => {
  const { attachment, sealedRoot } = await textAttachment('terminal marker');
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  let block = true;
  const broker = new AttachmentCapabilityBroker({
    beforeRead: async (_attachment, signal) => {
      if (!block) return;
      entered();
      await Promise.race([
        releasePromise,
        new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      ]);
    }
  });
  await broker.selectSealedRoot(sealedRoot);
  const firstPrepared = await broker.prepareDispatch([attachment]);
  const siblingPrepared = await broker.prepareDispatch([attachment]);
  const first = broker.bindTurn(firstPrepared, scope);
  const sibling = broker.bindTurn(siblingPrepared, { ...scope, turnId: 'turn-sibling' });
  const inFlight = first.handle(request(firstPrepared.textAttachments[0].capability, null));
  await enteredPromise;
  const expired = first.expire('turn_terminal');
  release();
  await expired;
  expect((await inFlight).response.success).toBe(false);
  block = false;
  expect((await sibling.handle(request(siblingPrepared.textAttachments[0].capability, null))).response.success).toBe(true);
});

test('rejects a file from another root even when its digest and shape are otherwise valid', async () => {
  const first = await textAttachment('first');
  const second = await textAttachment('second');
  const broker = new AttachmentCapabilityBroker();
  await broker.selectSealedRoot(first.sealedRoot);
  await expect(broker.prepareDispatch([second.attachment])).rejects.toThrow('attachment_store_ownership_invalid');
});

test('sanitizes a missing sealed root without returning its private path', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'orquesta-private-root-sentinel-'));
  roots.push(base);
  const missingRoot = path.join(base, 'PRIVATE_ROOT_SENTINEL');
  const broker = new AttachmentCapabilityBroker();
  let serialized = '';
  try {
    await broker.selectSealedRoot(missingRoot);
  } catch (error) {
    serialized = JSON.stringify({ reason: error instanceof Error ? error.message : String(error) });
  }
  expect(serialized).toContain('attachment_root_unavailable');
  expect(serialized).not.toContain(missingRoot);
  expect(serialized).not.toContain('PRIVATE_ROOT_SENTINEL');
});

test('sanitizes a file removed before dispatch without path, handle, or digest disclosure', async () => {
  const { attachment, sealedRoot } = await textAttachment('PRIVATE_CONTENT_SENTINEL');
  const broker = new AttachmentCapabilityBroker();
  await broker.selectSealedRoot(sealedRoot);
  await unlink(attachment.sealedAbsolutePath);
  let serialized = '';
  try {
    await broker.prepareDispatch([attachment]);
  } catch (error) {
    serialized = JSON.stringify({ reason: error instanceof Error ? error.message : String(error) });
  }
  expect(serialized).toContain('attachment_read_failed');
  for (const secret of [sealedRoot, attachment.sealedAbsolutePath, attachment.attachmentStoreHandle, attachment.sha256]) {
    expect(serialized).not.toContain(secret);
  }
});

test('returns only a stable bounded failure if a verified file disappears before a tool read', async () => {
  const { attachment, broker, prepared } = await preparedText('PRIVATE_READ_SENTINEL');
  const capability = prepared.textAttachments[0].capability;
  const handler = broker.bindTurn(prepared, scope);
  await unlink(attachment.sealedAbsolutePath);
  const result = await handler.handle(request(capability, null));
  const serialized = JSON.stringify(result.response);
  expect(result.response.success).toBe(false);
  expect(result.response.contentItems[0].text).toBe('attachment_read_failed');
  for (const secret of [attachment.sealedAbsolutePath, attachment.attachmentStoreHandle, attachment.sha256, 'PRIVATE_READ_SENTINEL']) {
    expect(serialized).not.toContain(secret);
  }
});

test('reports digest mismatch as a stable code without returning the claimed or observed digest', async () => {
  const { attachment, sealedRoot } = await textAttachment('PRIVATE_DIGEST_SENTINEL');
  const broker = new AttachmentCapabilityBroker();
  await broker.selectSealedRoot(sealedRoot);
  const claimedDigest = 'f'.repeat(64);
  let serialized = '';
  try {
    await broker.prepareDispatch([{ ...attachment, sha256: claimedDigest }]);
  } catch (error) {
    serialized = JSON.stringify({ reason: error instanceof Error ? error.message : String(error) });
  }
  expect(serialized).toContain('attachment_digest_mismatch');
  expect(serialized).not.toContain(attachment.sha256);
  expect(serialized).not.toContain(claimedDigest);
  expect(serialized).not.toContain(attachment.attachmentStoreHandle);
  expect(serialized).not.toContain(attachment.sealedAbsolutePath);
});

test('rejects a handle that is not the exact sealed direct-child basename', async () => {
  const { attachment, sealedRoot } = await textAttachment('mismatch');
  const broker = new AttachmentCapabilityBroker();
  await broker.selectSealedRoot(sealedRoot);
  await expect(broker.prepareDispatch([{ ...attachment, attachmentStoreHandle: randomUUID() }]))
    .rejects.toThrow('attachment_store_ownership_invalid');
});

test('rejects text media metadata that conflicts with the canonical display-name extension', async () => {
  const { attachment, sealedRoot } = await textAttachment('{}', 'data.json', 'text/html');
  const broker = new AttachmentCapabilityBroker();
  await broker.selectSealedRoot(sealedRoot);
  await expect(broker.prepareDispatch([attachment])).rejects.toThrow('attachment_text_contract_invalid');
});

test('matches Native display-name scalar and control-character validation at Core ingress', async () => {
  const valid = await textAttachment('valid', `${'😀'.repeat(251)}.txt`);
  const broker = new AttachmentCapabilityBroker();
  await broker.selectSealedRoot(valid.sealedRoot);
  await expect(broker.prepareDispatch([valid.attachment])).resolves.toBeDefined();

  for (const displayName of ['', `${'a'.repeat(252)}.txt`, 'unsafe\nname.txt']) {
    const invalid = await textAttachment('invalid', displayName);
    await broker.selectSealedRoot(invalid.sealedRoot);
    await expect(broker.prepareDispatch([invalid.attachment])).rejects.toThrow('attachment_private_shape_invalid');
  }
});

test('requires exact canonical media type casing and rejects unknown extension aliases', async () => {
  const cased = await textAttachment('{}', 'data.JSON', 'Application/JSON');
  const broker = new AttachmentCapabilityBroker();
  await broker.selectSealedRoot(cased.sealedRoot);
  await expect(broker.prepareDispatch([cased.attachment])).rejects.toThrow('attachment_text_contract_invalid');
  const unknown = await textAttachment('plain', 'data.text', 'text/plain');
  await broker.selectSealedRoot(unknown.sealedRoot);
  await expect(broker.prepareDispatch([unknown.attachment])).rejects.toThrow('attachment_text_contract_invalid');
});

test('uses only the Core-derived canonical text format in the Provider guide', async () => {
  const { attachment, sealedRoot } = await textAttachment('{}', 'data.JSON', 'application/json');
  const broker = new AttachmentCapabilityBroker();
  await broker.selectSealedRoot(sealedRoot);
  const prepared = await broker.prepareDispatch([attachment]);
  const guide = providerAttachmentGuide(prepared);
  expect(guide).toContain('"format":"application/json"');
  expect(guide).not.toContain(attachment.sealedAbsolutePath);
});

test('rejects a symlink or reparse alias for the selected sealed root', async () => {
  const { base, sealedRoot } = await textAttachment('root alias');
  const alias = path.join(base, 'sealed-alias');
  try {
    await symlink(sealedRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }
  const broker = new AttachmentCapabilityBroker();
  await expect(broker.selectSealedRoot(alias)).rejects.toThrow(/attachment_sealed_root_(invalid|alias)/u);
});

test('poisons an already-bound turn when the sealed root identity is replaced', async () => {
  const { attachment, base, sealedRoot, broker, prepared } = await preparedText('replace root');
  const capability = prepared.textAttachments[0].capability;
  const handler = broker.bindTurn(prepared, scope);
  const oldRoot = path.join(base, 'sealed-old');
  await rename(sealedRoot, oldRoot);
  await mkdir(sealedRoot);
  await writeFile(path.join(sealedRoot, attachment.attachmentStoreHandle), Buffer.from('replace root'));
  expect((await handler.handle(request(capability, null))).response.success).toBe(false);
});

test('expires old capabilities and invalidates prepared dispatches when root authority switches', async () => {
  const first = await preparedText('first root');
  const second = await textAttachment('second root');
  const activeCapability = first.prepared.textAttachments[0].capability;
  const active = first.broker.bindTurn(first.prepared, scope);
  const unbound = await first.broker.prepareDispatch([first.attachment]);
  await first.broker.selectSealedRoot(second.sealedRoot);
  expect((await active.handle(request(activeCapability, null))).response.success).toBe(false);
  expect(() => first.broker.bindTurn(unbound, { ...scope, turnId: 'turn-2' }))
    .toThrow('attachment_dispatch_binding_invalid');
});
