import { ArrowDown, Bot, UserRound } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ConversationMessage } from '../../../contracts/bridge';
import type { AgentUiModel } from '../../../contracts/orquesta-ui';
import { OverlayFrame } from '../../components/OverlayFrame';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export function ConversationHistory({ targetAgentId, agents, messages, onClose }: {
  targetAgentId: string;
  agents: AgentUiModel[];
  messages: ConversationMessage[];
  onClose(): void;
}) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const target = agents.find((agent) => agent.id === targetAgentId)?.displayName ?? targetAgentId;
  const scrollLatest = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  useEffect(() => { scrollLatest(); }, [messages]);
  return (
    <OverlayFrame title={`${t('conversation')} · ${target}`} ariaLabel={`${t('conversation')} · ${target}`} className="conversation-overlay" onClose={onClose}>
      <div ref={scroller} className="conversation-scroll" data-testid="conversation-scroll">
        {messages.length ? messages.map((message) => (
          <article key={message.id} className={`conversation-message conversation-message--${message.role}`}>
            <span className="conversation-message__avatar">{message.role === 'user' ? <UserRound size={16} /> : <Bot size={16} />}</span>
            <div><header><strong>{message.authorLabel}</strong><time>{formatDateTime(message.createdAt)}</time></header><p>{message.text}</p>{message.evidenceLabel ? <small>{message.evidenceLabel}</small> : null}</div>
          </article>
        )) : <div className="empty-detail">{t('noMessages')}</div>}
      </div>
      <button type="button" className="latest-button" onClick={scrollLatest}><ArrowDown size={14} />{t('latest')}</button>
    </OverlayFrame>
  );
}
