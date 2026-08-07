import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type MessageDeliveryState = 'queued' | 'dispatch_accepted' | 'turn_started' | 'completed' | 'failed';

export interface MessageDeliveryInput {
  rootPath: string;
  messageId: string;
  correlationId: string;
  projectId: string;
  targetAgentId: string;
  threadId: string | null;
  turnId: string | null;
  state: MessageDeliveryState;
  errorCode?: string | null;
}

export interface MessageDeliveryRecord {
  schema_version: 1;
  message_id: string;
  correlation_id: string;
  project_id: string;
  target_agent_id: string;
  thread_id: string | null;
  turn_id: string | null;
  state: MessageDeliveryState;
  observed_at: string;
  error_code: string | null;
}

export interface MessageLedgerWriter {
  record(input: MessageDeliveryInput): Promise<boolean>;
}

const STATE_RANK: Record<MessageDeliveryState, number> = {
  queued: 0,
  dispatch_accepted: 1,
  turn_started: 2,
  completed: 3,
  failed: 3
};

function isDeliveryState(value: unknown): value is MessageDeliveryState {
  return typeof value === 'string' && Object.hasOwn(STATE_RANK, value);
}

function ledgerPath(rootPath: string): string {
  return path.join(path.resolve(rootPath), '.orquesta', 'state', 'messages.jsonl');
}

export class MessageLedger implements MessageLedgerWriter {
  private readonly now: () => Date;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly loadedRoots = new Set<string>();
  private readonly states = new Map<string, MessageDeliveryState>();

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async record(input: MessageDeliveryInput): Promise<boolean> {
    const rootPath = path.resolve(input.rootPath);
    const previous = this.queues.get(rootPath) ?? Promise.resolve();
    let written = false;
    const pending = previous.catch(() => undefined).then(async () => {
      await this.load(rootPath);
      const stateKey = `${rootPath}\u0000${input.messageId}`;
      const current = this.states.get(stateKey);
      if (current && (STATE_RANK[current] >= STATE_RANK[input.state] || STATE_RANK[current] === 3)) return;
      const record: MessageDeliveryRecord = {
        schema_version: 1,
        message_id: input.messageId,
        correlation_id: input.correlationId,
        project_id: input.projectId,
        target_agent_id: input.targetAgentId,
        thread_id: input.threadId,
        turn_id: input.turnId,
        state: input.state,
        observed_at: this.now().toISOString(),
        error_code: input.errorCode ?? null
      };
      const filePath = ledgerPath(rootPath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
      this.states.set(stateKey, input.state);
      written = true;
    });
    this.queues.set(rootPath, pending);
    try {
      await pending;
      return written;
    } finally {
      if (this.queues.get(rootPath) === pending) this.queues.delete(rootPath);
    }
  }

  private async load(rootPath: string): Promise<void> {
    if (this.loadedRoots.has(rootPath)) return;
    try {
      const content = await readFile(ledgerPath(rootPath), 'utf8');
      for (const line of content.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Partial<MessageDeliveryRecord>;
          if (typeof parsed.message_id === 'string' && isDeliveryState(parsed.state)) {
            this.states.set(`${rootPath}\u0000${parsed.message_id}`, parsed.state);
          }
        } catch {
          // A torn final JSONL record must not make the whole delivery ledger unreadable.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loadedRoots.add(rootPath);
  }
}

export function messageLedgerPath(rootPath: string): string {
  return ledgerPath(rootPath);
}
