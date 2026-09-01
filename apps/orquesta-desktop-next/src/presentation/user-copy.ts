import type {
  AgentExecutionPhase,
  AgentStatus,
  AttentionItem,
  ConversationActivity,
  ConversationActivityState,
  PlanActivityStep,
  RuntimeEvidenceSummary,
  WorkflowAttempt,
  WorkflowBatch,
} from '../domain/models';
import type { SimpleUserMessageId, UserMessage } from '../application/user-message';

export type UserLocale = 'ja' | 'en';

type LocalizedCopy = Readonly<{ ja: string; en: string }>;

const USER_MESSAGE_COPY: Readonly<Record<SimpleUserMessageId, LocalizedCopy>> = {
  generic_failure: { ja: '処理を完了できませんでした。状態を更新して、もう一度お試しください。', en: 'The operation could not be completed. Refresh the project and try again.' },
  project_name_invalid: { ja: 'このプロジェクト名は使えません。別の名前を入力してください。', en: 'That project name cannot be used. Choose another name.' },
  project_metadata_directory_selected: { ja: '「.orquesta」は管理用フォルダです。一つ上のプロジェクトフォルダを選んでください。', en: '“.orquesta” is a metadata folder. Select its parent project folder.' },
  project_recent_forget_active: { ja: '使用中のプロジェクトは一覧から外せません。先にプロジェクトを停止してください。', en: 'The active project cannot be removed from the list. Stop it first.' },
  dispatch_state_unknown: { ja: '前回の送信状態を確認できませんでした。プロジェクトを開き直してください。', en: 'The previous send state could not be confirmed. Reopen the project.' },
  runtime_changed: { ja: 'プロジェクトの接続状態が変わりました。プロジェクトを開き直してください。', en: 'The project connection changed. Reopen the project.' },
  voice_failed: { ja: '音声入力を完了できませんでした。マイクからもう一度お試しください。', en: 'Voice input could not be completed. Try the microphone again.' },
  attachment_failed: { ja: 'ファイルを処理できませんでした。添付し直してください。', en: 'The file could not be processed. Attach it again.' },
  last_agent_save_failed: { ja: '最後に開いていた担当者を保存できませんでした。次回は担当者を選び直してください。', en: 'The last open agent could not be saved. Select the agent again next time.' },
  voice_start_failed: { ja: '音声入力を開始できませんでした。アプリを開き直してください。', en: 'Voice input could not start. Reopen the app.' },
  voice_project_changed: { ja: '録音中にプロジェクトが変わりました。入力内容は変更していません。', en: 'The project changed while recording. Your draft was not changed.' },
  voice_draft_changed: { ja: '録音中に入力内容が変わりました。現在の入力を残しています。', en: 'The draft changed while recording. The current draft was kept.' },
  attachment_preview_unavailable: { ja: 'この添付はプレビューできません。', en: 'This attachment cannot be previewed.' },
  attachment_preview_too_large: { ja: 'この画像はプレビュー上限を超えているため表示できません。', en: 'This image exceeds the preview limit and cannot be shown.' },
  attachment_preview_stale: { ja: '添付画像が更新されたため、古いプレビューを閉じました。', en: 'The attachment changed, so the old preview was closed.' },
  attachment_batch_rejected: { ja: '選んだファイルをすべて追加できなかったため、今回は追加していません。', en: 'Not all selected files could be added, so none were attached.' },
  recover_before_send: { ja: '前回の送信を復旧してから送信できます。', en: 'Recover the previous send before sending again.' },
  recover_before_retry: { ja: '前回の送信を復旧してから再送できます。', en: 'Recover the previous send before retrying.' },
  retry_sent: { ja: '同じ内容を新しいターンとして再送しました。', en: 'The same message was retried as a new turn.' },
  steer_sent: { ja: '現在の回答へ追加の指示を送りました。', en: 'The additional instruction was sent to the current response.' },
  steer_outcome_unknown: { ja: '追加の指示が届いたか確認できないため、このターンへの再送を止めています。', en: 'Delivery of the additional instruction is unknown, so another steer is blocked for this turn.' },
  stop_accepted: { ja: '停止要求を受け付けました。', en: 'The stop request was accepted.' },
  stop_outcome_unknown: { ja: '停止要求が届いたか確認できないため、このターンへの操作を止めています。', en: 'Delivery of the stop request is unknown, so further actions are blocked for this turn.' },
  approval_stale: { ja: 'この判断要求は現在の接続と一致しないため回答できません。', en: 'This decision request no longer matches the current connection.' },
  approval_recorded: { ja: '判断を記録しました。', en: 'The decision was recorded.' },
  approval_outcome_unknown: { ja: '判断が届いたか確認できないため、同じ要求への再回答を止めています。', en: 'Delivery of the decision is unknown, so another response is blocked for this request.' },
  inspection_started: { ja: '監査を開始しました。', en: 'The inspection started.' },
  workflow_saved: { ja: 'ワークフローを保存しました。', en: 'The workflow was saved.' },
  workflow_started: { ja: '反復実行を開始しました。', en: 'The workflow run started.' },
  recovery_open_project: { ja: 'このプロジェクトを開き直すと、送信の復旧を続けられます。', en: 'Reopen this project to continue send recovery.' },
  recovery_message_sent: { ja: '前回のメッセージは送信済みでした。', en: 'The previous message had been sent.' },
  recovery_send_failed_cleaned: { ja: '前回の送信は完了していませんでした。添付ファイルを整理しました。', en: 'The previous send did not complete. Its attachments were cleaned up.' },
  recovery_update_failed: { ja: '送信状態を更新できませんでした。プロジェクトを開き直してください。', en: 'The send state could not be updated. Reopen the project.' },
  recovery_checked: { ja: '前回のメッセージ状態を確認しました。', en: 'The previous message state was checked.' },
  conversation_save_failed: { ja: '会話履歴を保存できませんでした。プロジェクトを開き直してください。', en: 'Conversation history could not be saved. Reopen the project.' },
  voice_recovery_wait: { ja: '音声処理の終了を確認しています。しばらくしてからもう一度お試しください。', en: 'Voice processing is still being checked. Try again shortly.' },
  voice_transcription_failed: { ja: '音声の文字起こしに失敗しました。マイクからもう一度お試しください。', en: 'Voice transcription failed. Try the microphone again.' },
  voice_transcript_too_large: { ja: '音声入力を追加すると入力欄の上限を超えます。文章を短くしてからもう一度お試しください。', en: 'The voice transcript would exceed the input limit. Shorten the draft and try again.' },
  voice_recovery_draft: { ja: '音声処理の終了を確認しています。入力内容は下書きへ戻しました。', en: 'Voice processing is still being checked. The transcript was restored to the draft.' },
  voice_restored_after_restart: { ja: '前回の音声入力を入力欄へ戻しました。', en: 'The previous voice transcript was restored to the input.' },
  voice_restored: { ja: '音声入力を入力欄へ戻しました。', en: 'The voice transcript was restored to the input.' },
  voice_ack_state_failed: { ja: '音声入力の保存状態を確認できませんでした。', en: 'The saved voice-input state could not be confirmed.' },
  voice_terminal_state_failed: { ja: '音声入力の完了状態を確認できませんでした。', en: 'The final voice-input state could not be confirmed.' },
  voice_terminal_state_unknown: { ja: '音声入力が完了したか確認できません。キャンセルするか、アプリを開き直してください。', en: 'Voice-input completion is unknown. Cancel it or reopen the app.' },
  unexpected_runtime_stop_failed: { ja: '選択中でないプロジェクトの実行を停止できませんでした。', en: 'An unselected project run could not be stopped.' },
  project_start_draft_preserved: { ja: 'プロジェクト開始中に更新された下書きは、空のWORKに残しています。', en: 'The draft changed during project startup and was kept in empty WORK.' },
  project_entry_draft_conflict: { ja: '移行先にも下書きがあるため、両方を残して停止しました。', en: 'The target already has a draft, so both drafts were kept and the move stopped.' },
};

export function userMessageCopy(message: UserMessage, locale: UserLocale): string {
  return USER_MESSAGE_COPY[message.id][locale];
}

function localized<T extends string>(
  value: T,
  locale: UserLocale,
  copy: Readonly<Record<T, LocalizedCopy>>,
): string {
  return copy[value][locale];
}

export function agentStatusCopy(status: AgentStatus, locale: UserLocale): string {
  return localized(status, locale, {
    working: { ja: '実行中', en: 'Working' },
    assigned_waiting: { ja: '開始待ち', en: 'Waiting to start' },
    standby: { ja: '待機', en: 'Standing by' },
    approval_wait: { ja: '判断待ち', en: 'Waiting for decision' },
    blocked: { ja: '停止中', en: 'Blocked' },
    stale: { ja: '古い記録', en: 'Outdated record' },
    report_ready: { ja: '報告あり', en: 'Report ready' },
    unknown: { ja: '不明', en: 'Unknown' },
  });
}

export function executionPhaseCopy(phase: AgentExecutionPhase, locale: UserLocale): string {
  return localized(phase, locale, {
    queueing: { ja: '送信準備中', en: 'Preparing' },
    accepted: { ja: '受理済み・開始待ち', en: 'Waiting to start' },
    working: { ja: '作業中', en: 'Working' },
    stopping: { ja: '停止中', en: 'Stopping' },
    completed: { ja: '完了', en: 'Completed' },
    interrupted: { ja: '中断', en: 'Interrupted' },
    failed: { ja: '失敗', en: 'Failed' },
  });
}

const UI_STATE_COPY: Readonly<Record<string, LocalizedCopy>> = {
  Starting: { ja: '起動中', en: 'Starting' },
  Ready: { ja: '準備完了', en: 'Ready' },
  Stopping: { ja: '停止中', en: 'Stopping' },
  Stopped: { ja: '停止', en: 'Stopped' },
  Failed: { ja: '失敗', en: 'Failed' },
  working: { ja: '作業中', en: 'Working' },
  ready: { ja: '準備完了', en: 'Ready' },
  running: { ja: '実行中', en: 'Running' },
  queued: { ja: '待機中', en: 'Queued' },
  assigned: { ja: '担当決定', en: 'Assigned' },
  dispatch_accepted: { ja: '受付済み', en: 'Accepted for delivery' },
  turn_started: { ja: '開始済み', en: 'Started' },
  in_progress: { ja: '進行中', en: 'In progress' },
  blocked: { ja: '停止中', en: 'Blocked' },
  approval_wait: { ja: '判断待ち', en: 'Waiting for decision' },
  report_ready: { ja: '報告あり', en: 'Report ready' },
  needs_review: { ja: '確認待ち', en: 'Needs review' },
  accepted: { ja: '受理済み', en: 'Accepted' },
  failed: { ja: '失敗', en: 'Failed' },
  pending: { ja: '確認待ち', en: 'Pending' },
  completed: { ja: '完了', en: 'Completed' },
  interrupted: { ja: '中断', en: 'Interrupted' },
  cancelled: { ja: '取消済み', en: 'Cancelled' },
  done: { ja: '完了', en: 'Done' },
  current: { ja: '進行中', en: 'Current' },
  unknown: { ja: '不明', en: 'Unknown' },
};

export function uiStateCopy(value: string | null | undefined, locale: UserLocale): string {
  if (!value) return locale === 'ja' ? '不明' : 'Unknown';
  return UI_STATE_COPY[value]?.[locale] ?? (locale === 'ja' ? '状態不明' : 'Unknown state');
}

export function approvalDecisionCopy(decision: string, locale: UserLocale): string {
  const copy: Readonly<Record<string, LocalizedCopy>> = {
    accept: { ja: '今回のみ許可', en: 'Accept once' },
    acceptForSession: { ja: 'この作業中は許可', en: 'Accept for session' },
    decline: { ja: '許可しない', en: 'Decline' },
    cancel: { ja: '取り消す', en: 'Cancel' },
  };
  return copy[decision]?.[locale] ?? (locale === 'ja' ? '選択肢' : 'Decision');
}

export function conversationActivityStateCopy(state: ConversationActivityState, locale: UserLocale): string {
  return localized(state, locale, {
    running: { ja: '実行中', en: 'RUNNING' },
    completed: { ja: '完了', en: 'COMPLETE' },
    failed: { ja: '失敗', en: 'FAILED' },
    declined: { ja: '見送り', en: 'DECLINED' },
    updated: { ja: '更新', en: 'UPDATED' },
    unknown: { ja: '結果不明', en: 'UNKNOWN' },
  });
}

export function conversationActivityKindCopy(kind: ConversationActivity['kind'], locale: UserLocale): string {
  return localized(kind, locale, {
    command: { ja: 'コマンド', en: 'Command' },
    tool: { ja: 'ツール', en: 'Tool' },
    file_change: { ja: 'ファイル変更', en: 'File changes' },
    diff: { ja: '差分', en: 'Diff' },
    plan: { ja: '計画', en: 'Plan' },
  });
}

export function planStepStatusCopy(status: PlanActivityStep['status'], locale: UserLocale): string {
  return localized(status, locale, {
    pending: { ja: '未着手', en: 'Pending' },
    inProgress: { ja: '進行中', en: 'In progress' },
    completed: { ja: '完了', en: 'Completed' },
  });
}

export function fileChangeKindCopy(kind: string, locale: UserLocale): string {
  const copy: Readonly<Record<string, LocalizedCopy>> = {
    add: { ja: '追加', en: 'Added' }, added: { ja: '追加', en: 'Added' },
    create: { ja: '新規作成', en: 'Created' }, created: { ja: '新規作成', en: 'Created' },
    modify: { ja: '変更', en: 'Modified' }, modified: { ja: '変更', en: 'Modified' },
    update: { ja: '更新', en: 'Updated' }, updated: { ja: '更新', en: 'Updated' },
    delete: { ja: '削除', en: 'Deleted' }, deleted: { ja: '削除', en: 'Deleted' },
    remove: { ja: '削除', en: 'Removed' }, removed: { ja: '削除', en: 'Removed' },
    rename: { ja: '名前変更', en: 'Renamed' }, renamed: { ja: '名前変更', en: 'Renamed' },
  };
  return copy[kind.toLowerCase()]?.[locale] ?? (locale === 'ja' ? 'ファイル変更' : 'File changed');
}

export function workflowBatchStatusCopy(status: WorkflowBatch['status'], locale: UserLocale): string {
  return localized(status, locale, {
    queued: { ja: '待機中', en: 'Queued' }, running: { ja: '実行中', en: 'Running' },
    cancelling: { ja: '停止中', en: 'Stopping' }, completed: { ja: '完了', en: 'Completed' },
    partial: { ja: '一部完了', en: 'Partially completed' }, failed: { ja: '失敗', en: 'Failed' },
    cancelled: { ja: '取消済み', en: 'Cancelled' },
  });
}

export function workflowAttemptStatusCopy(status: WorkflowAttempt['status'], locale: UserLocale): string {
  return localized(status, locale, {
    queued: { ja: '待機中', en: 'Queued' }, starting: { ja: '開始中', en: 'Starting' },
    running: { ja: '実行中', en: 'Running' }, completed: { ja: '完了', en: 'Completed' },
    failed: { ja: '失敗', en: 'Failed' }, cancelled: { ja: '取消済み', en: 'Cancelled' },
  });
}

export function workflowCheckOutcomeCopy(outcome: WorkflowAttempt['checkOutcome'], locale: UserLocale): string | null {
  if (outcome === null) return null;
  return localized(outcome, locale, {
    passed: { ja: '確認通過', en: 'Check passed' }, failed: { ja: '確認失敗', en: 'Check failed' },
    unassessed: { ja: '未評価', en: 'Not assessed' },
  });
}

export function evidenceLevelCopy(level: RuntimeEvidenceSummary['level'], locale: UserLocale): string {
  return localized(level, locale, {
    reported: { ja: '報告', en: 'Reported' }, proven: { ja: '確認済み', en: 'Verified' },
    inferred: { ja: '推定', en: 'Inferred' }, unknown: { ja: '不明', en: 'Unknown' },
  });
}

export function evidenceTypeCopy(type: string, locale: UserLocale): string {
  const copy: Readonly<Record<string, LocalizedCopy>> = {
    runtime: { ja: '実行記録', en: 'Runtime record' }, approval: { ja: '判断記録', en: 'Decision record' },
    report: { ja: '報告', en: 'Report' }, test: { ja: 'テスト', en: 'Test' }, inspection: { ja: '監査', en: 'Inspection' },
  };
  return copy[type.toLowerCase()]?.[locale] ?? (locale === 'ja' ? '作業記録' : 'Work record');
}

export function attentionPriorityCopy(priority: AttentionItem['priority'], locale: UserLocale): string {
  return localized(priority, locale, {
    low: { ja: '低', en: 'Low' }, medium: { ja: '中', en: 'Medium' },
    high: { ja: '高', en: 'High' }, blocker: { ja: '要対応', en: 'Blocking' },
  });
}

export function attentionTypeCopy(type: AttentionItem['type'], locale: UserLocale): string {
  return localized(type, locale, {
    question: { ja: '質問', en: 'Question' }, approval: { ja: '判断', en: 'Decision' },
    report_review: { ja: '報告確認', en: 'Report review' }, repair: { ja: '修復', en: 'Repair' },
    error: { ja: '問題', en: 'Issue' }, direction: { ja: '方針確認', en: 'Direction' },
  });
}

export function attentionActionCopy(action: AttentionItem['actionKind'], locale: UserLocale): string {
  return localized(action, locale, {
    answer: { ja: '回答する', en: 'Answer' },
    approve: { ja: '内容を確認', en: 'Review request' },
    review: { ja: '確認する', en: 'Review' },
    do: { ja: '対応する', en: 'Open' },
  });
}

export function attentionPresentationCopy(item: AttentionItem, locale: UserLocale): { title: string; summary: string } {
  if (!item.runtimeApproval) {
    return {
      title: item.title ?? (locale === 'ja' ? '確認が必要です' : 'Review needed'),
      summary: item.summary ?? '',
    };
  }
  const copy = {
    file_change: {
      ja: { title: 'ファイル変更の確認', summary: 'このプロジェクトのファイルを変更してよいか確認してください。' },
      en: { title: 'Review file changes', summary: 'Review whether this project may be changed.' },
    },
    command_execution: {
      ja: { title: 'コマンド実行の確認', summary: 'この作業でコマンドを実行してよいか確認してください。' },
      en: { title: 'Review command execution', summary: 'Review whether this task may run a command.' },
    },
    other: {
      ja: { title: '操作内容の確認', summary: 'この操作を続けてよいか確認してください。' },
      en: { title: 'Review this action', summary: 'Review whether this action may continue.' },
    },
  } as const;
  return copy[item.runtimeApproval.requestedEffectKind][locale];
}
