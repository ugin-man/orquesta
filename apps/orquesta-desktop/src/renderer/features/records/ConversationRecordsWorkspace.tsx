import { Bot, Network, Search, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationMessage } from '../../../contracts/bridge';
import type { AgentUiModel } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export interface ConversationRecordsWorkspaceProps {
  agents: AgentUiModel[];
  targetAgentId: string;
  messages: ConversationMessage[];
  loading: boolean;
  hasOlder: boolean;
  onSelectTarget(agentId: string): void;
  onLoadOlder(): void;
}

function includesQuery(agent: AgentUiModel, query: string): boolean {
  if (!query) return true;
  const searchable = `${agent.displayName} ${agent.role} ${agent.id}`.toLocaleLowerCase();
  return searchable.includes(query.toLocaleLowerCase());
}

export function ConversationRecordsWorkspace({ agents, targetAgentId, messages, loading, hasOlder, onSelectTarget, onLoadOlder }: ConversationRecordsWorkspaceProps) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState('');
  const messagePane = useRef<HTMLDivElement>(null);
  const copy = locale === 'ja' ? {
    channels: '会話先', search: '会話先を検索', coordinator: '統括者', routes: 'エージェント経路', noMatch: '一致する会話先はありません。',
    logicalTarget: '論理的な送信先', actualDelivery: '実際の送信先', coordinatorThread: '統括者のCodex thread', route: '経路', direct: '統括者への直接メッセージ', reading: '履歴を読み込み中…'
  } : {
    channels: 'Conversation channels', search: 'Search conversations', coordinator: 'Coordinator', routes: 'Agent routes', noMatch: 'No matching conversations.',
    logicalTarget: 'Logical target', actualDelivery: 'Actual delivery', coordinatorThread: 'Coordinator Codex thread', route: 'Route', direct: 'Direct coordinator message', reading: 'Reading history…'
  };
  const coordinator = agents.find((agent) => agent.id === 'orchestrator') ?? agents[0] ?? null;
  const routes = useMemo(() => agents.filter((agent) => agent.id !== coordinator?.id), [agents, coordinator?.id]);
  const visibleCoordinator = coordinator && includesQuery(coordinator, query) ? coordinator : null;
  const visibleRoutes = routes.filter((agent) => includesQuery(agent, query));
  const target = agents.find((agent) => agent.id === targetAgentId) ?? coordinator;

  useEffect(() => {
    if (!loading && messages.length && messagePane.current) messagePane.current.scrollTop = messagePane.current.scrollHeight;
  }, [loading, messages, targetAgentId]);

  const channelButton = (agent: AgentUiModel) => (
    <button
      type="button"
      key={agent.id}
      className="conversation-channel"
      aria-label={`${agent.displayName} · ${agent.role}`}
      aria-current={agent.id === targetAgentId ? 'page' : undefined}
      onClick={() => onSelectTarget(agent.id)}
    >
      <span className="conversation-channel__icon">{agent.id === coordinator?.id ? <Network size={16} /> : <Bot size={16} />}</span>
      <span className="conversation-channel__copy"><strong>{agent.displayName}</strong><small>{agent.role}</small></span>
      <i className={`conversation-channel__status conversation-channel__status--${agent.status}`} aria-hidden="true" />
      <span className="conversation-channel__state">{agent.statusLabel}</span>
    </button>
  );

  return (
    <section className="conversation-records-workspace" aria-label={locale === 'ja' ? '会話記録' : 'Conversation records'}>
      <nav className="conversation-channels" aria-label={copy.channels}>
        <label className="conversation-channel-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={copy.search} placeholder={copy.search} />
        </label>
        <div className="conversation-channel-list">
          {visibleCoordinator ? <section className="conversation-channel-group"><h3>{copy.coordinator}</h3>{channelButton(visibleCoordinator)}</section> : null}
          {visibleRoutes.length ? <section className="conversation-channel-group"><h3>{copy.routes}</h3>{visibleRoutes.map(channelButton)}</section> : null}
          {!visibleCoordinator && !visibleRoutes.length ? <p className="conversation-channel-empty">{copy.noMatch}</p> : null}
        </div>
      </nav>

      <section className="conversation-history" aria-label={locale === 'ja' ? `${target?.displayName ?? targetAgentId}との会話` : `Conversation with ${target?.displayName ?? targetAgentId}`}>
        <header className="conversation-history__header">
          <div><small>{locale === 'ja' ? '選択中の会話' : 'Selected conversation'}</small><h2>{t('recordConversation')} · {target?.displayName ?? targetAgentId}</h2></div>
          <dl>
            <div><dt>{copy.logicalTarget}</dt><dd>{target?.displayName ?? targetAgentId} <span>{targetAgentId}</span></dd></div>
            <div><dt>{copy.actualDelivery}</dt><dd>{copy.coordinatorThread}</dd></div>
            <div><dt>{copy.route}</dt><dd>{targetAgentId === coordinator?.id ? copy.direct : `agent_id=${targetAgentId}`}</dd></div>
          </dl>
        </header>
        <div ref={messagePane} className="conversation-history__messages">
          {hasOlder ? <button type="button" className="workspace-load-older" disabled={loading} onClick={onLoadOlder}>{loading ? t('loadingOlder') : t('loadOlder')}</button> : null}
          {loading && !messages.length ? <p className="workspace-empty">{copy.reading}</p> : null}
          {!loading && !messages.length ? <p className="workspace-empty">{t('noMessages')}</p> : null}
          {messages.map((message) => (
            <article key={message.id} className={`workspace-message workspace-message--${message.role}`}>
              <span>{message.role === 'user' ? <UserRound size={15} /> : <Bot size={15} />}</span>
              <div>
                <header><strong>{message.authorLabel}</strong><time>{formatDateTime(message.createdAt)}</time></header>
                <p>{message.text}</p>
                {message.evidenceLabel ? <small className="workspace-message__evidence">{message.evidenceLabel}</small> : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
