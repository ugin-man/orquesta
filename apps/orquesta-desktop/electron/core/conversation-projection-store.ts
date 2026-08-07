import { createReadStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export interface ConversationProjectionRecord {
  id: string;
  role: 'user' | 'agent';
  text: string;
  createdAt: string;
  targetAgentId: string | null;
}

export interface ConversationProjectionPage {
  items: ConversationProjectionRecord[];
  nextCursor: string | null;
}

export interface ConversationProjectionReader {
  listPage(input: {
    threadId: string;
    targetAgentId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<ConversationProjectionPage | null>;
}

export interface ConversationProjectionStoreOptions {
  storageRoot: string;
  codexHome?: string;
  resolveRolloutPath?: (threadId: string) => Promise<string | null>;
  now?: () => Date;
  onScan?: (event: { threadId: string; sourcePath: string; startOffset: number; endOffset: number }) => void;
}

interface ProjectionIndexEntry {
  id: string;
  offset: number;
  length: number;
}

interface ProjectionIndex {
  schema_version: 1;
  thread_id: string;
  projection_size: number;
  entries: ProjectionIndexEntry[];
}

interface ProjectionMetadata {
  schema_version: 1;
  thread_id: string;
  source_path: string;
  source_offset: number;
  source_size: number;
  source_mtime_ms: number;
  last_target_agent_id: string | null;
  updated_at: string;
}

interface ScannedProjection {
  records: ConversationProjectionRecord[];
  endOffset: number;
  lastTargetAgentId: string | null;
}

const THREAD_ID = /^[a-zA-Z0-9._-]{1,128}$/u;
const ROUTED_TEXT = /^<orquesta_target agent_id="([a-zA-Z0-9._:-]{1,128})">\n([\s\S]*)\n<\/orquesta_target>$/u;

function safeThreadId(threadId: string): string {
  if (!THREAD_ID.test(threadId)) throw new Error('Conversation projection thread id is invalid');
  return threadId;
}

export function conversationProjectionPaths(storageRoot: string, threadId: string): {
  messages: string;
  index: string;
  metadata: string;
} {
  const base = path.join(path.resolve(storageRoot), safeThreadId(threadId));
  return {
    messages: `${base}.jsonl`,
    index: `${base}.index.json`,
    metadata: `${base}.meta.json`
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timestamp(value: unknown, fallback: Date): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback.toISOString();
}

function routedText(value: string): { text: string; targetAgentId: string | null } {
  const match = ROUTED_TEXT.exec(value);
  return match
    ? { targetAgentId: match[1], text: match[2] }
    : { targetAgentId: null, text: value };
}

function messageText(content: unknown, role: 'user' | 'assistant'): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((value) => {
    const item = record(value);
    if (!item) return [];
    const type = text(item.type);
    const valueText = text(item.text);
    if (!valueText) return [];
    if (role === 'user') return type === 'input_text' ? [valueText] : [];
    return type === 'output_text' || type === 'text' ? [valueText] : [];
  });
  // The first user input is the actual user-authored message. Later input_text
  // parts can contain AGENTS.md and environment context injected by Codex.
  return role === 'user' ? parts[0] ?? null : text(parts.join('\n'));
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, filePath);
}

function validIndex(value: ProjectionIndex | null, threadId: string): value is ProjectionIndex {
  return Boolean(value && value.schema_version === 1 && value.thread_id === threadId
    && Number.isSafeInteger(value.projection_size) && value.projection_size >= 0
    && Array.isArray(value.entries) && value.entries.every((entry) => (
      entry && typeof entry.id === 'string' && Number.isSafeInteger(entry.offset) && entry.offset >= 0
      && Number.isSafeInteger(entry.length) && entry.length >= 0
    )));
}

function validMetadata(value: ProjectionMetadata | null, threadId: string): value is ProjectionMetadata {
  return Boolean(value && value.schema_version === 1 && value.thread_id === threadId
    && typeof value.source_path === 'string' && Number.isSafeInteger(value.source_offset) && value.source_offset >= 0
    && Number.isSafeInteger(value.source_size) && value.source_size >= 0
    && typeof value.source_mtime_ms === 'number'
    && (value.last_target_agent_id === null || typeof value.last_target_agent_id === 'string'));
}

async function recoverIndex(messagesPath: string, threadId: string): Promise<ProjectionIndex> {
  let source: Buffer;
  try {
    source = await readFile(messagesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema_version: 1, thread_id: threadId, projection_size: 0, entries: [] };
    }
    throw error;
  }
  const entries: ProjectionIndexEntry[] = [];
  const ids = new Set<string>();
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (index < source.length && source[index] !== 0x0a) continue;
    const end = index > start && source[index - 1] === 0x0d ? index - 1 : index;
    if (end > start) {
      try {
        const parsed = JSON.parse(source.subarray(start, end).toString('utf8')) as ConversationProjectionRecord;
        if (typeof parsed.id === 'string' && !ids.has(parsed.id)) {
          ids.add(parsed.id);
          entries.push({ id: parsed.id, offset: start, length: end - start });
        }
      } catch {
        // A torn final projection line is ignored and will be recovered from the source rollout.
      }
    }
    start = index + 1;
  }
  return { schema_version: 1, thread_id: threadId, projection_size: source.length, entries };
}

async function loadIndex(paths: ReturnType<typeof conversationProjectionPaths>, threadId: string): Promise<ProjectionIndex> {
  const parsed = await readJson<ProjectionIndex>(paths.index);
  if (validIndex(parsed, threadId)) {
    try {
      if ((await stat(paths.messages)).size === parsed.projection_size) return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return recoverIndex(paths.messages, threadId);
}

function dateDirectories(threadId: string): string[] {
  const compact = threadId.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{12}/u.test(compact)) return [];
  const milliseconds = Number.parseInt(compact.slice(0, 12), 16);
  if (!Number.isFinite(milliseconds)) return [];
  return [-1, 0, 1].map((offset) => {
    const date = new Date(milliseconds + offset * 86_400_000);
    return [String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join(path.sep);
  });
}

async function matchingRollouts(directory: string, threadId: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).flatMap((entry) => (
      entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)
        ? [path.join(directory, entry.name)]
        : []
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function defaultRolloutPath(codexHome: string, threadId: string): Promise<string | null> {
  const candidates = [
    ...(await matchingRollouts(path.join(codexHome, 'archived_sessions'), threadId)),
    ...(await Promise.all(dateDirectories(threadId).map((directory) => (
      matchingRollouts(path.join(codexHome, 'sessions', directory), threadId)
    )))).flat()
  ];
  const available = (await Promise.all(candidates.map(async (candidate) => {
    try {
      const details = await stat(candidate);
      return { candidate, modified: details.mtimeMs };
    } catch {
      return null;
    }
  }))).flatMap((value) => value ?? []);
  return available.sort((left, right) => right.modified - left.modified)[0]?.candidate ?? null;
}

async function scanRollout(
  sourcePath: string,
  startOffset: number,
  initialTargetAgentId: string | null,
  now: () => Date
): Promise<ScannedProjection> {
  const details = await stat(sourcePath);
  if (startOffset >= details.size) {
    return { records: [], endOffset: details.size, lastTargetAgentId: initialTargetAgentId };
  }
  const handle = await open(sourcePath, 'r');
  let endsWithNewline = false;
  try {
    const finalByte = Buffer.alloc(1);
    if (details.size > 0) {
      await handle.read(finalByte, 0, 1, details.size - 1);
      endsWithNewline = finalByte[0] === 0x0a;
    }
  } finally {
    await handle.close();
  }

  const reader = readline.createInterface({
    input: createReadStream(sourcePath, { encoding: 'utf8', start: startOffset, highWaterMark: 4 * 1024 * 1024 }),
    crlfDelay: Infinity
  });
  const records: ConversationProjectionRecord[] = [];
  let pendingLine: string | null = null;
  let endOffset = startOffset;
  let lastTargetAgentId = initialTargetAgentId;

  const accept = (line: string) => {
    endOffset += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.includes('"type":"response_item"') || !line.includes('"payload":{"type":"message"')) return;
    try {
      const envelope = record(JSON.parse(line));
      const payload = record(envelope?.payload);
      const role = text(payload?.role);
      if (payload?.type !== 'message' || (role !== 'user' && role !== 'assistant')) return;
      if (role === 'assistant' && payload?.phase !== 'final_answer') return;
      const visibleText = messageText(payload.content, role);
      if (!visibleText) return;
      const id = text(payload.id);
      if (!id) return;
      if (role === 'user') {
        const routed = routedText(visibleText);
        lastTargetAgentId = routed.targetAgentId;
        records.push({
          id,
          role: 'user',
          text: routed.text,
          targetAgentId: routed.targetAgentId,
          createdAt: timestamp(envelope?.timestamp, now())
        });
      } else {
        records.push({
          id,
          role: 'agent',
          text: visibleText,
          targetAgentId: lastTargetAgentId,
          createdAt: timestamp(envelope?.timestamp, now())
        });
      }
    } catch {
      // Unknown or forward-compatible rollout records do not block the display projection.
    }
  };

  for await (const line of reader) {
    if (pendingLine !== null) accept(pendingLine);
    pendingLine = line;
  }
  if (pendingLine !== null && endsWithNewline) accept(pendingLine);
  return { records, endOffset, lastTargetAgentId };
}

export class ConversationProjectionStore implements ConversationProjectionReader {
  readonly #options: Required<Pick<ConversationProjectionStoreOptions, 'codexHome' | 'now'>> & ConversationProjectionStoreOptions;
  readonly #syncByThread = new Map<string, Promise<ProjectionIndex | null>>();

  constructor(options: ConversationProjectionStoreOptions) {
    this.#options = {
      ...options,
      codexHome: options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
      now: options.now ?? (() => new Date())
    };
  }

  async listPage(input: {
    threadId: string;
    targetAgentId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<ConversationProjectionPage | null> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new Error('Conversation projection limit must be an integer from 1 to 200');
    }
    const threadId = safeThreadId(input.threadId);
    const index = await this.#sync(threadId);
    if (!index) return null;
    let end = index.entries.length;
    if (input.cursor) {
      const match = /^projection:(\d+)$/u.exec(input.cursor);
      if (!match) throw new Error('Conversation projection cursor is invalid');
      end = Number(match[1]);
      if (!Number.isSafeInteger(end) || end < 0 || end > index.entries.length) {
        throw new Error('Conversation projection cursor is invalid');
      }
    }
    const start = Math.max(0, end - input.limit);
    const paths = conversationProjectionPaths(this.#options.storageRoot, threadId);
    const handle = await open(paths.messages, 'r');
    try {
      const items = await Promise.all(index.entries.slice(start, end).map(async (entry) => {
        const buffer = Buffer.alloc(entry.length);
        await handle.read(buffer, 0, entry.length, entry.offset);
        const item = JSON.parse(buffer.toString('utf8')) as ConversationProjectionRecord;
        return { ...item, targetAgentId: item.targetAgentId ?? input.targetAgentId };
      }));
      return { items, nextCursor: start > 0 ? `projection:${start}` : null };
    } finally {
      await handle.close();
    }
  }

  async #sync(threadId: string): Promise<ProjectionIndex | null> {
    const current = this.#syncByThread.get(threadId);
    if (current) return current;
    const pending = this.#syncThread(threadId);
    this.#syncByThread.set(threadId, pending);
    try {
      return await pending;
    } finally {
      if (this.#syncByThread.get(threadId) === pending) this.#syncByThread.delete(threadId);
    }
  }

  async #syncThread(threadId: string): Promise<ProjectionIndex | null> {
    const paths = conversationProjectionPaths(this.#options.storageRoot, threadId);
    const index = await loadIndex(paths, threadId);
    const parsedMetadata = await readJson<ProjectionMetadata>(paths.metadata);
    const metadata = validMetadata(parsedMetadata, threadId) ? parsedMetadata : null;
    const resolveSource = this.#options.resolveRolloutPath
      ?? ((value: string) => defaultRolloutPath(this.#options.codexHome, value));
    const sourcePath = await resolveSource(threadId);
    if (!sourcePath) return index.entries.length || index.projection_size > 0 ? index : null;
    const source = await stat(sourcePath);
    const sameSource = metadata
      ? path.resolve(metadata.source_path).toLowerCase() === path.resolve(sourcePath).toLowerCase()
      : false;
    const relocatedThreadSource = metadata
      ? path.basename(metadata.source_path).endsWith(`-${threadId}.jsonl`)
        && path.basename(sourcePath).endsWith(`-${threadId}.jsonl`)
      : false;
    const canContinue = Boolean(metadata && metadata.source_offset <= source.size
      && (sameSource || relocatedThreadSource));
    const startOffset = canContinue ? metadata!.source_offset : 0;
    if (startOffset === source.size && index.projection_size >= 0) return index;

    const scanned = await scanRollout(sourcePath, startOffset, canContinue ? metadata!.last_target_agent_id : null, this.#options.now);
    this.#options.onScan?.({ threadId, sourcePath, startOffset, endOffset: scanned.endOffset });
    const nextIndex = startOffset === 0
      ? await this.#replaceProjection(paths, threadId, scanned.records)
      : await this.#appendProjection(paths, threadId, index, scanned.records);
    const nextMetadata: ProjectionMetadata = {
      schema_version: 1,
      thread_id: threadId,
      source_path: sourcePath,
      source_offset: scanned.endOffset,
      source_size: source.size,
      source_mtime_ms: source.mtimeMs,
      last_target_agent_id: scanned.lastTargetAgentId,
      updated_at: this.#options.now().toISOString()
    };
    await writeAtomic(paths.metadata, `${JSON.stringify(nextMetadata, null, 2)}\n`);
    return nextIndex;
  }

  async #replaceProjection(
    paths: ReturnType<typeof conversationProjectionPaths>,
    threadId: string,
    records: ConversationProjectionRecord[]
  ): Promise<ProjectionIndex> {
    const unique = [...new Map(records.map((item) => [item.id, item])).values()];
    const entries: ProjectionIndexEntry[] = [];
    let offset = 0;
    const content = unique.map((item) => {
      const serialized = JSON.stringify(item);
      const length = Buffer.byteLength(serialized, 'utf8');
      entries.push({ id: item.id, offset, length });
      offset += length + 1;
      return serialized;
    }).join('\n');
    await writeAtomic(paths.messages, content ? `${content}\n` : '');
    const index: ProjectionIndex = { schema_version: 1, thread_id: threadId, projection_size: offset, entries };
    await writeAtomic(paths.index, `${JSON.stringify(index)}\n`);
    return index;
  }

  async #appendProjection(
    paths: ReturnType<typeof conversationProjectionPaths>,
    threadId: string,
    current: ProjectionIndex,
    records: ConversationProjectionRecord[]
  ): Promise<ProjectionIndex> {
    const ids = new Set(current.entries.map((entry) => entry.id));
    const additions = records.filter((item) => {
      if (ids.has(item.id)) return false;
      ids.add(item.id);
      return true;
    });
    if (!additions.length) return current;
    await mkdir(path.dirname(paths.messages), { recursive: true });
    let offset = current.projection_size;
    const entries = [...current.entries];
    const content = additions.map((item) => {
      const serialized = JSON.stringify(item);
      const length = Buffer.byteLength(serialized, 'utf8');
      entries.push({ id: item.id, offset, length });
      offset += length + 1;
      return serialized;
    }).join('\n');
    await appendFile(paths.messages, `${content}\n`, 'utf8');
    const index: ProjectionIndex = { schema_version: 1, thread_id: threadId, projection_size: offset, entries };
    await writeAtomic(paths.index, `${JSON.stringify(index)}\n`);
    return index;
  }
}
