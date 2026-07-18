import type { ConversationMessage, ConversationPage } from '../../src/contracts/bridge';
import type { RuntimeNotification } from './protocol';

type JsonObject = Record<string, unknown>;

export interface AppServerRpc {
  start(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
  subscribe(listener: (notification: JsonObject) => void): () => void;
  stop(): Promise<void>;
}

export interface RuntimeMessageInput {
  projectId: string;
  rootPath: string;
  threadId: string | null;
  targetAgentId: string;
  text: string;
  localImagePaths: string[];
}

export interface RuntimeDispatch {
  threadId: string;
  turnId: string;
  actualModel: string | null;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function routeText(targetAgentId: string, text: string): string {
  return targetAgentId === 'orchestrator'
    ? text
    : `<orquesta_target agent_id="${targetAgentId}">\n${text}\n</orquesta_target>`;
}

function parseRouteText(text: string): { targetAgentId: string; text: string } {
  const match = /^<orquesta_target agent_id="([a-zA-Z0-9._:-]{1,128})">\n([\s\S]*)\n<\/orquesta_target>$/u.exec(text);
  return match ? { targetAgentId: match[1], text: match[2] } : { targetAgentId: 'orchestrator', text };
}

function isoFromSeconds(value: unknown, fallback: Date): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1_000).toISOString() : fallback.toISOString();
}

export class CodexRuntime {
  readonly #client: AppServerRpc;

  constructor(client: AppServerRpc) {
    this.#client = client;
  }

  subscribe(listener: (notification: RuntimeNotification) => void): () => void {
    return this.#client.subscribe((message) => {
      const method = string(message.method);
      const params = object(message.params);
      const threadId = string(params?.threadId);
      if (!threadId) return;
      const turn = object(params?.turn);
      const turnId = string(turn?.id) ?? string(params?.turnId);
      if (method === 'turn/started') listener({ kind: 'turn_started', threadId, turnId, text: null });
      else if (method === 'turn/completed') {
        const status = string(turn?.status) ?? 'completed';
        const error = object(turn?.error);
        listener({
          kind: status === 'failed' ? 'turn_failed' : 'turn_completed', threadId, turnId,
          text: status === 'failed' ? string(error?.message) ?? 'Codex turn failed.' : null
        });
      } else if (method === 'item/completed') {
        const item = object(params?.item);
        if (item?.type === 'agentMessage') listener({ kind: 'agent_message', threadId, turnId, text: string(item.text) });
      }
    });
  }

  async sendMessage(input: RuntimeMessageInput): Promise<RuntimeDispatch> {
    await this.#client.start();
    let threadResponse: JsonObject;
    if (input.threadId) {
      try {
        threadResponse = object(await this.#client.request('thread/resume', {
          threadId: input.threadId,
          cwd: input.rootPath,
          approvalPolicy: 'never',
          sandbox: 'workspace-write'
        })) ?? {};
      } catch {
        threadResponse = await this.#startThread(input.rootPath);
      }
    } else {
      threadResponse = await this.#startThread(input.rootPath);
    }
    const threadId = string(object(threadResponse.thread)?.id);
    if (!threadId) throw new Error('Codex App Server did not return a thread id');
    const turnResponse = object(await this.#client.request('turn/start', {
      threadId,
      input: [
        { type: 'text', text: routeText(input.targetAgentId, input.text), text_elements: [] },
        ...input.localImagePaths.map((filePath) => ({ type: 'localImage', path: filePath }))
      ]
    }));
    const turnId = string(object(turnResponse?.turn)?.id);
    if (!turnId) throw new Error('Codex App Server did not accept the turn');
    return { threadId, turnId, actualModel: string(threadResponse.model) };
  }

  async #startThread(rootPath: string): Promise<JsonObject> {
    return object(await this.#client.request('thread/start', {
      cwd: rootPath,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      developerInstructions: 'You are the coordinator for this Orquesta project. Follow the repository guidance, keep the user informed, and delegate only when the task benefits from it.'
    })) ?? {};
  }

  async listConversation(input: { threadId: string; targetAgentId: string; limit: number }): Promise<ConversationPage> {
    await this.#client.start();
    const response = object(await this.#client.request('thread/read', { threadId: input.threadId, includeTurns: true }));
    const thread = object(response?.thread);
    const turns = Array.isArray(thread?.turns) ? thread.turns.flatMap((turn) => object(turn) ?? []) : [];
    const now = new Date();
    const messages: ConversationMessage[] = [];
    for (const turn of turns) {
      const items = Array.isArray(turn.items) ? turn.items.flatMap((item) => object(item) ?? []) : [];
      let turnTarget = 'orchestrator';
      for (const item of items) {
        if (item.type === 'userMessage') {
          const content = Array.isArray(item.content) ? item.content.flatMap((entry) => object(entry) ?? []) : [];
          const rawText = content.filter((entry) => entry.type === 'text').map((entry) => string(entry.text) ?? '').join('\n').trim();
          if (!rawText) continue;
          const routed = parseRouteText(rawText);
          turnTarget = routed.targetAgentId;
          messages.push({
            id: string(item.id) ?? `user-${messages.length}`,
            role: 'user', targetAgentId: routed.targetAgentId, authorLabel: 'You', text: routed.text,
            createdAt: isoFromSeconds(turn.startedAt, now), evidenceLabel: 'Codex thread history'
          });
        } else if (item.type === 'agentMessage') {
          const text = string(item.text);
          if (!text) continue;
          messages.push({
            id: string(item.id) ?? `agent-${messages.length}`,
            role: 'agent', targetAgentId: turnTarget, authorLabel: 'Coordinator', text,
            createdAt: isoFromSeconds(turn.completedAt ?? turn.startedAt, now), evidenceLabel: 'Codex thread history'
          });
        }
      }
    }
    const filtered = messages.filter((message) => message.targetAgentId === input.targetAgentId);
    return { items: filtered.slice(-Math.max(1, Math.min(input.limit, 200))), nextCursor: null };
  }

  stop(): Promise<void> {
    return this.#client.stop();
  }
}
