export type SimpleUserMessageId =
  | 'generic_failure'
  | 'project_name_invalid'
  | 'project_metadata_directory_selected'
  | 'project_recent_forget_active'
  | 'dispatch_state_unknown'
  | 'runtime_changed'
  | 'voice_failed'
  | 'attachment_failed'
  | 'last_agent_save_failed'
  | 'voice_start_failed'
  | 'voice_project_changed'
  | 'voice_draft_changed'
  | 'attachment_preview_unavailable'
  | 'attachment_preview_too_large'
  | 'attachment_preview_stale'
  | 'attachment_batch_rejected'
  | 'recover_before_send'
  | 'recover_before_retry'
  | 'retry_sent'
  | 'steer_sent'
  | 'steer_outcome_unknown'
  | 'stop_accepted'
  | 'stop_outcome_unknown'
  | 'approval_stale'
  | 'approval_recorded'
  | 'approval_outcome_unknown'
  | 'inspection_started'
  | 'workflow_saved'
  | 'workflow_started'
  | 'recovery_open_project'
  | 'recovery_message_sent'
  | 'recovery_send_failed_cleaned'
  | 'recovery_update_failed'
  | 'recovery_checked'
  | 'conversation_save_failed'
  | 'voice_recovery_wait'
  | 'voice_transcription_failed'
  | 'voice_transcript_too_large'
  | 'voice_recovery_draft'
  | 'voice_restored_after_restart'
  | 'voice_restored'
  | 'voice_ack_state_failed'
  | 'voice_terminal_state_failed'
  | 'voice_terminal_state_unknown'
  | 'unexpected_runtime_stop_failed'
  | 'project_start_draft_preserved'
  | 'project_entry_draft_conflict';

export type UserMessage = { id: SimpleUserMessageId };

export function userMessage(id: SimpleUserMessageId): UserMessage {
  return { id };
}

export class UserMessageError extends Error {
  constructor(readonly userMessage: UserMessage) {
    super(userMessage.id);
    this.name = 'UserMessageError';
  }
}
