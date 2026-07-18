import { ChevronDown, Clock3, Paperclip, Send, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { ComposerAttachment } from '../../../contracts/bridge';
import type { AgentUiModel } from '../../../contracts/orquesta-ui';
import { useI18n } from '../i18n/I18nProvider';

export function CommandComposer({
  agents,
  online,
  sending,
  value,
  targetAgentId,
  error,
  directSendFailure,
  attachments,
  canAttach,
  onTargetChange,
  onChange,
  onSend,
  onOpenHistory,
  onSelectAttachments,
  onRemoveAttachment,
  onRetryDirect,
  onOpenCodexDraft
}: {
  agents: AgentUiModel[];
  online: boolean;
  sending: boolean;
  value: string;
  targetAgentId: string;
  error: string | null;
  directSendFailure: string | null;
  attachments: ComposerAttachment[];
  canAttach: boolean;
  onTargetChange(id: string): void;
  onChange(value: string): void;
  onSend(): void;
  onOpenHistory(): void;
  onSelectAttachments(): void;
  onRemoveAttachment(id: string): void;
  onRetryDirect(): void;
  onOpenCodexDraft(): void;
}) {
  const { t } = useI18n();
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (online) onSend();
    }
  };
  return (
    <section className="command-composer" aria-label="Command composer">
      <div className="command-composer__topline">
        <label><span>{t('to')}</span><span className="composer-select-wrap"><select value={targetAgentId} onChange={(event) => onTargetChange(event.target.value)} aria-label="Target agent">
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
        </select><ChevronDown size={13} aria-hidden="true" /></span></label>
        <button type="button" className="composer-history" onClick={onOpenHistory} aria-label={`${t('conversationHistory')} · ${agents.find((agent) => agent.id === targetAgentId)?.displayName ?? targetAgentId}`}><Clock3 size={15} /><span>{t('conversationHistory')}</span></button>
      </div>
      <div className="command-composer__input-row">
        <textarea rows={1} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={handleKeyDown} placeholder={t('composerPlaceholder')} aria-label={t('composerPlaceholder')} />
        <div className="command-composer__buttons">
          {canAttach ? <button type="button" className="icon-button" onClick={onSelectAttachments} aria-label={t('attachImages')}><Paperclip size={20} /></button> : null}
          <button type="button" className="composer-send" onClick={onSend} disabled={!online || sending || !value.trim()} aria-label={t('sendMessage')}><Send size={19} /></button>
        </div>
      </div>
      {attachments.length ? <div className="composer-attachments" aria-label={t('selectedAttachments')}>{attachments.map((attachment) => <span key={attachment.id}>{attachment.name}<button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label={`${t('removeAttachment')} ${attachment.name}`}><X size={12} /></button></span>)}</div> : null}
      {!online ? <p className="composer-message composer-message--warning">{t('offlineDraft')}</p> : directSendFailure ? (
        <div className="composer-fallback" role="status">
          <p className="composer-message composer-message--error">{directSendFailure}</p>
          <div>
            <button type="button" onClick={onRetryDirect}>{t('retryDirectSend')}</button>
            <button type="button" onClick={onOpenCodexDraft}>{t('openUnsentCodexDraft')}</button>
          </div>
        </div>
      ) : error ? <p className="composer-message composer-message--error">{error}</p> : null}
    </section>
  );
}
