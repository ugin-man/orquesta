import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  ImagePlus,
  LoaderCircle,
  Mic,
  Paperclip,
  Plus,
  Send,
  ShieldAlert,
  Square,
  X,
  Zap,
} from 'lucide-react';
import {
  projectLifecycleLocksConversation,
  selectCurrentProjectDispatchRecovery,
  selectCurrentUserOrchestratorId,
  selectProjectLifecycle,
} from '../../application/selectors';
import type { ApplicationStore } from '../../application/store';
import type { ApplicationState } from '../../application/state';
import { UserMessageError, userMessage } from '../../application/user-message';
import { userMessageCopy } from '../../presentation/user-copy';
import { VoiceCaptureController, type VoiceCaptureHandle } from './voice-capture';
import {
  ATTACHMENT_PICKER_ACCEPT,
  fitsMessageTextPolicy,
  MESSAGE_TEXT_MAX_LENGTH_HINT,
} from '../../domain/validation';

interface ComposerProps {
  state: ApplicationState;
  store: ApplicationStore;
  locale: 'ja' | 'en';
  onOpenProjects?(sendDraft?: boolean): void;
  onNewProject?(sendDraft?: boolean): void;
  onStartFromFolder?(sendDraft?: boolean): void;
  guideDismissed?: boolean;
  onDismissGuide?(): void;
}

function voiceElapsed(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function compactModelLabel(displayName: string): string {
  return displayName.replace(/^GPT-/iu, '').replaceAll('-', ' ');
}

function reasoningEffortLabel(effort: string | null, locale: 'ja' | 'en'): string {
  if (!effort) return locale === 'ja' ? '既定' : 'Default';
  const japanese: Record<string, string> = {
    none: 'なし', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '極高', max: '最大', ultra: 'Ultra',
  };
  return locale === 'ja' ? japanese[effort] ?? effort : effort.replace(/^./u, (character) => character.toUpperCase());
}

export function Composer({
  state,
  store,
  locale,
  onOpenProjects,
  onNewProject,
  onStartFromFolder,
  guideDismissed = false,
  onDismissGuide,
}: ComposerProps) {
  const agent = state.snapshot?.agents.find((candidate) => candidate.id === state.selectedAgentId) ?? null;
  const orchestratorAgentId = state.snapshot ? selectCurrentUserOrchestratorId(state.snapshot) : null;
  const activity = agent ? state.executions[agent.id] ?? null : null;
  const projectId = state.snapshot?.project.id ?? null;
  const [fileInputGeneration, setFileInputGeneration] = useState(0);
  const [dropActive, setDropActive] = useState(false);
  const [, setPreviewRevision] = useState(0);
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [voiceController] = useState(() => new VoiceCaptureController());
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [openComposerMenu, setOpenComposerMenu] = useState<'access' | 'runtime' | null>(null);
  const [runtimeSubmenu, setRuntimeSubmenu] = useState<'model' | 'effort' | 'speed' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerControlsRef = useRef<HTMLDivElement>(null);
  const runtimeSubmenuCloseTimerRef = useRef<number | null>(null);
  const voiceHandleRef = useRef<VoiceCaptureHandle | null>(null);
  const composingRef = useRef(false);
  const previewGeneration = useRef(0);
  const previewUrls = useRef(new Map<string, string>());
  const attachmentKey = state.attachments
    .map((attachment) => `${attachment.id}:${attachment.selectionId}:${attachment.sizeBytes}`)
    .join('|');
  const activeTurnKey = activity?.threadId && activity.turnId ? `${activity.threadId}:${activity.turnId}` : null;
  const activeTurn = Boolean(activity?.threadId && activity.turnId
    && ['accepted', 'working', 'stopping'].includes(activity.phase));
  const steerMode = Boolean(activity?.canInterrupt && activity.threadId && activity.turnId
    && ['accepted', 'working'].includes(activity.phase));
  const steerBlocked = steerMode && (activeTurnKey === state.turnMutationAcceptedTurnKey
    || activeTurnKey === state.turnMutationOutcomeUnknownTurnKey);
  const stopPending = state.sending && state.conversationAction === 'stop';
  const stopMode = stopPending || (steerMode && !state.draft.trim());
  const projectLifecycle = selectProjectLifecycle(state);
  const noProject = projectLifecycle === 'no_project';
  const registeredInactive = projectLifecycle === 'registered_inactive';
  const startMode = noProject || registeredInactive;
  const projectPreparing = projectLifecycle === 'activating'
    || projectLifecycle === 'hydrating_snapshot'
    || projectLifecycle === 'bootstrapping_foundation';
  const projectStopping = projectLifecycle === 'stopping';
  const transitionLocked = state.addingProject || projectLifecycleLocksConversation(projectLifecycle);
  const currentRecovery = selectCurrentProjectDispatchRecovery(state);
  const dispatchBlocked = Boolean(currentRecovery && currentRecovery.kind !== 'accepted');
  const canStop = Boolean(stopMode && steerMode && state.runtimeAuthority && !state.sending
    && !steerBlocked && !transitionLocked && !dispatchBlocked);
  const voiceSendIntentQueued = Boolean(
    state.voiceActiveOperationRef
    && state.voiceSendIntentOperationRef === state.voiceActiveOperationRef,
  );
  const canQueueVoiceSend = Boolean(
    agent && state.runtimeAuthority && state.voiceActiveOperationRef
    && ['recording', 'stopping', 'transcribing'].includes(state.voiceCapturePhase)
    && !voiceSendIntentQueued && !state.sending && !steerBlocked && !transitionLocked && !dispatchBlocked && !activeTurn,
  );
  const projectActionLocked = transitionLocked || state.voiceCapturePhase !== 'idle';
  const canSend = Boolean(agent && state.draft.trim() && fitsMessageTextPolicy(state.draft)
    && state.runtimeAuthority && !state.sending
    && !state.attachmentSelectionPending && !state.attachmentRemovalPending
    && state.voiceCapturePhase === 'idle'
    && !steerBlocked && !transitionLocked && !dispatchBlocked && (!activeTurn || steerMode));
  const canStartProject = Boolean(noProject && state.draft.trim() && onNewProject && !projectActionLocked);
  const canResumeProject = Boolean(registeredInactive && state.draft.trim() && onOpenProjects && !projectActionLocked);
  const attachmentBusy = state.sending || state.attachmentSelectionPending
    || state.attachmentRemovalPending || steerMode;
  const composerSettingsLocked = transitionLocked || activeTurn || state.sending;
  const selectedModel = state.runtimeModels.find((model) => model.id === state.composerModelId) ?? null;
  const modelLabel = selectedModel
    ? compactModelLabel(selectedModel.displayName)
    : state.runtimeModelsLoading ? (locale === 'ja' ? '読込中' : 'Loading') : (locale === 'ja' ? 'モデル' : 'Model');
  const effortLabel = reasoningEffortLabel(state.composerReasoningEffort, locale);
  const cancelRuntimeSubmenuClose = () => {
    if (runtimeSubmenuCloseTimerRef.current === null) return;
    window.clearTimeout(runtimeSubmenuCloseTimerRef.current);
    runtimeSubmenuCloseTimerRef.current = null;
  };
  const openRuntimeSubmenu = (submenu: 'model' | 'effort' | 'speed') => {
    cancelRuntimeSubmenuClose();
    setRuntimeSubmenu(submenu);
  };
  const scheduleRuntimeSubmenuClose = () => {
    cancelRuntimeSubmenuClose();
    runtimeSubmenuCloseTimerRef.current = window.setTimeout(() => {
      runtimeSubmenuCloseTimerRef.current = null;
      setRuntimeSubmenu(null);
    }, 180);
  };
  useEffect(() => {
    const closeComposerMenus = () => {
      if (runtimeSubmenuCloseTimerRef.current !== null) {
        window.clearTimeout(runtimeSubmenuCloseTimerRef.current);
        runtimeSubmenuCloseTimerRef.current = null;
      }
      setRuntimeSubmenu(null);
      setOpenComposerMenu(null);
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!composerControlsRef.current?.contains(event.target as Node)) closeComposerMenus();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeComposerMenus();
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
      if (runtimeSubmenuCloseTimerRef.current !== null) {
        window.clearTimeout(runtimeSubmenuCloseTimerRef.current);
        runtimeSubmenuCloseTimerRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    const generation = previewGeneration.current + 1;
    previewGeneration.current = generation;
    const currentIds = new Set(state.attachments.map((attachment) => attachment.id));
    for (const [id, url] of previewUrls.current) {
      if (currentIds.has(id)) continue;
      URL.revokeObjectURL(url);
      previewUrls.current.delete(id);
    }
    setPreviewErrors((current) => Object.fromEntries(
      Object.entries(current).filter(([id]) => currentIds.has(id)),
    ));
    const loadSequentially = async () => {
      for (const attachment of state.attachments) {
        if (previewGeneration.current !== generation) return;
        if (attachment.kind !== 'image') continue;
        if (previewUrls.current.has(attachment.id) || previewErrors[attachment.id]) continue;
        try {
          const preview = await store.readAttachmentPreview(attachment.id);
          if (previewGeneration.current !== generation) return;
          const url = URL.createObjectURL(new Blob([preview.bytes], { type: preview.mediaType }));
          if (previewGeneration.current !== generation) {
            URL.revokeObjectURL(url);
            return;
          }
          previewUrls.current.set(attachment.id, url);
          setPreviewRevision((revision) => revision + 1);
        } catch (error) {
          if (previewGeneration.current !== generation) return;
          setPreviewErrors((current) => ({
            ...current,
            [attachment.id]: error instanceof UserMessageError
              ? userMessageCopy(error.userMessage, locale)
              : userMessageCopy(userMessage('attachment_preview_unavailable'), locale),
          }));
        }
      }
    };
    void loadSequentially();
  // previewErrors is intentionally read as the snapshot for this exact attachment generation.
  // A failed item is not retried until the attachment identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentKey, locale, store]);
  useEffect(() => () => {
    previewGeneration.current += 1;
    for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
    previewUrls.current.clear();
  }, []);
  useEffect(() => () => {
    const activeOperationRef = voiceHandleRef.current?.operationRef ?? null;
    voiceHandleRef.current = null;
    void voiceController.dispose();
    if (activeOperationRef) store.cancelVoiceCapture(activeOperationRef);
  }, [store, voiceController]);
  useEffect(() => {
    if (state.voiceCapturePhase !== 'recording') {
      setRecordingSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setRecordingSeconds(Math.floor((Date.now() - startedAt) / 1_000)), 250);
    return () => window.clearInterval(timer);
  }, [state.voiceCapturePhase]);
  const dismissGuide = () => {
    onDismissGuide?.();
  };
  const send = () => {
    if (stopMode) {
      if (canStop) void store.interruptActiveTurn();
      return;
    }
    if (canQueueVoiceSend && state.voiceActiveOperationRef) {
      const handle = voiceHandleRef.current;
      if (state.voiceCapturePhase === 'recording' && !handle) return;
      if (!store.requestVoiceSendIntent(state.voiceActiveOperationRef)) return;
      dismissGuide();
      if (state.voiceCapturePhase === 'recording' && handle) {
        store.markVoiceCaptureStopping(handle.operationRef);
        void handle.stop().catch(() => undefined);
      }
      return;
    }
    if (!canSend) {
      if (canStartProject) onNewProject?.(true);
      else if (canResumeProject) onOpenProjects?.(true);
      return;
    }
    dismissGuide();
    void (steerMode ? store.steerActiveTurn() : store.sendMessage());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = composingRef.current
      || event.nativeEvent.isComposing
      || event.nativeEvent.keyCode === 229;
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault();
      send();
    }
  };
  const stageFiles = (files: File[]) => {
    if (files.length === 0 || attachmentBusy || !state.runtimeAuthority) return;
    void store.stageAttachmentFiles(files);
  };
  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    setFileInputGeneration((generation) => generation + 1);
    stageFiles(files);
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = attachmentBusy ? 'none' : 'copy';
    if (!attachmentBusy) setDropActive(true);
  };
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropActive(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    setDropActive(false);
    stageFiles(Array.from(event.dataTransfer.files));
  };
  const onVoiceAction = () => {
    const phase = state.voiceCapturePhase;
    if (phase === 'requesting_permission') {
      const operationRef = state.voiceActiveOperationRef;
      void voiceController.cancelActive().finally(() => {
        if (operationRef) store.cancelVoiceCapture(operationRef);
      });
      return;
    }
    if (phase === 'recording') {
      const handle = voiceHandleRef.current;
      if (!handle) return;
      store.markVoiceCaptureStopping(handle.operationRef);
      void handle.stop().catch(() => undefined);
      return;
    }
    if (phase === 'transcribing') {
      const operationRef = state.voiceActiveOperationRef;
      if (operationRef) void store.cancelVoiceTranscription(operationRef);
      return;
    }
    if (phase !== 'idle' || !state.voiceStatus) return;
    if (!state.voiceStatus.requiredAssetsReady) {
      void store.prepareVoiceAssets();
      return;
    }
    const prepared = store.prepareVoiceCapture();
    if (!prepared) return;
    void voiceController.start({ operationRef: prepared.operationRef }).then((handle) => {
      voiceHandleRef.current = handle;
      store.markVoiceRecording(handle.operationRef);
      void handle.completion.then((completion) => {
        if (voiceHandleRef.current === handle) voiceHandleRef.current = null;
        if (completion.kind === 'captured') {
          void store.submitVoiceCapture(
            completion.capture.operationRef,
            completion.capture.pcm,
            completion.capture.sampleCount,
          );
        } else if (completion.kind === 'failed') {
          store.failVoiceCapture(handle.operationRef, completion.error);
        } else {
          store.cancelVoiceCapture(handle.operationRef);
        }
      });
    }).catch((error) => store.failVoiceCapture(prepared.operationRef, error));
  };
  const voiceAssetBusy = Boolean(state.voiceStatus?.assets.some((asset) => (
    asset.assetId === state.voiceStatus?.binaryAssetId || asset.assetId === state.voiceStatus?.initialModelAssetId
  ) && ['downloading', 'verifying', 'installing', 'deleting'].includes(asset.phase)));
  const requiredVoiceAssets = state.voiceStatus
    ? [state.voiceStatus.binaryAssetId, state.voiceStatus.initialModelAssetId].map((assetId) => (
        state.voiceStatus!.assets.find((asset) => asset.assetId === assetId) ?? null
      ))
    : [];
  const voiceAssetRecovery = requiredVoiceAssets.find((status) => status?.phase === 'recovery_required') ?? null;
  const voiceAssetFailure = requiredVoiceAssets.find((status) => status?.phase === 'failed') ?? null;
  const voiceAssetExpectedBytes = requiredVoiceAssets.reduce((sum, status) => sum + (status?.expectedBytes ?? 0), 0);
  const voiceAssetDownloadedBytes = requiredVoiceAssets.reduce((sum, status) => sum + (status?.downloadedBytes ?? 0), 0);
  const voiceAssetProgress = voiceAssetExpectedBytes > 0
    ? Math.min(100, Math.floor((voiceAssetDownloadedBytes / voiceAssetExpectedBytes) * 100)) : 0;
  const voiceSetupBlocked = Boolean(voiceAssetRecovery);
  const voiceLabel = !state.voiceStatus?.requiredAssetsReady
    ? (voiceAssetRecovery
        ? (locale === 'ja' ? '音声入力の復旧が必要' : 'VOICE RECOVERY REQUIRED')
        : voiceAssetFailure
          ? (locale === 'ja' ? '音声入力を再準備' : 'RETRY VOICE SETUP')
          : voiceAssetBusy
        ? (locale === 'ja' ? `音声入力を準備中 ${voiceAssetProgress}%` : `PREPARING VOICE INPUT ${voiceAssetProgress}%`)
        : (locale === 'ja' ? '音声入力を準備' : 'PREPARE VOICE INPUT'))
    : ({
        idle: locale === 'ja' ? '音声入力' : 'VOICE INPUT',
        requesting_permission: locale === 'ja' ? 'マイク接続を中止' : 'CANCEL MICROPHONE',
        recording: locale === 'ja' ? '録音を終了' : 'STOP RECORDING',
        stopping: locale === 'ja' ? '録音を確定中' : 'FINALIZING RECORDING',
        transcribing: locale === 'ja' ? '文字起こしを中止' : 'CANCEL TRANSCRIPTION',
        cancelling: locale === 'ja' ? '文字起こしを取消中' : 'CANCELLING TRANSCRIPTION',
      })[state.voiceCapturePhase];
  const voiceLive = voiceAssetBusy || state.voiceCapturePhase !== 'idle';
  const showProjectGuide = Boolean(
    projectId
    && agent?.id === orchestratorAgentId
    && !state.conversationLoading
    && state.messages.length === 0
    && !guideDismissed,
  );
  const primaryActionLabel = stopMode
    ? (stopPending
        ? (locale === 'ja' ? '停止中' : 'STOPPING')
        : (locale === 'ja' ? '応答を停止' : 'STOP RESPONSE'))
    : voiceSendIntentQueued
      ? (locale === 'ja' ? '文字起こし後に送信します' : 'WILL SEND AFTER TRANSCRIPTION')
      : canQueueVoiceSend
        ? (locale === 'ja' ? '録音を終了して文字起こし後に送信' : 'STOP, TRANSCRIBE, THEN SEND')
        : canStartProject
          ? (locale === 'ja' ? '新しいプロジェクトを作成して続行' : 'CREATE PROJECT')
          : canResumeProject
            ? (locale === 'ja' ? '再開するプロジェクトを選択' : 'CHOOSE PROJECT')
            : state.sending
              ? (state.conversationAction === 'steer'
                  ? (locale === 'ja' ? '送信中' : 'SENDING')
                  : state.conversationAction === 'retry'
                    ? (locale === 'ja' ? '再送中' : 'RETRYING')
                    : (locale === 'ja' ? '送信中' : 'SENDING'))
              : (locale === 'ja' ? '送信' : 'SEND');
  return (
    <section
      className={`composer plugin-surface light-surface${dropActive ? ' is-drop-active' : ''}`}
      aria-labelledby="composer-title"
      aria-busy={transitionLocked}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="surface-head composer-head">
        <span id="composer-title">COMMAND COMPOSER</span>
        <b>{agent ? `TO / ${agent.displayName.toUpperCase()}` : 'NO TARGET'}</b>
      </div>
      {state.attachments.length > 0 && (
        <ul className="attachment-list" aria-label={locale === 'ja' ? '添付ファイル' : 'Attachments'}>
          {state.attachments.map((attachment) => (
            <li key={attachment.id}>
              <span
                className="attachment-preview"
                aria-hidden="true"
                title={previewErrors[attachment.id]}
              >
                {attachment.kind === 'text'
                  ? <FileText data-preview="file" />
                  : previewUrls.current.has(attachment.id)
                  ? <img
                      src={previewUrls.current.get(attachment.id)!}
                      alt=""
                    />
                  : previewErrors[attachment.id]
                    ? <ImagePlus data-preview="unavailable" />
                    : <LoaderCircle className="attachment-preview-loading" />}
              </span>
              <span><b>{attachment.name}</b><small>{attachment.mediaType} · {Math.max(1, Math.ceil(attachment.sizeBytes / 1024))} KiB</small></span>
              <button
                type="button"
                onClick={() => void store.removeAttachment(attachment.id)}
                disabled={state.sending || state.attachmentSelectionPending || state.attachmentRemovalPending}
                aria-label={`${attachment.name} ${locale === 'ja' ? 'を削除' : 'remove'}`}
              ><X aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      {showProjectGuide && <aside className="composer-project-guide" aria-label={locale === 'ja' ? 'プロジェクト開始のヒント' : 'Project start tip'}>
        <div><b>{locale === 'ja' ? 'このプロジェクトについて教えてください' : 'Tell the orchestrator about this project'}</b><p>{locale === 'ja' ? 'やりたいことや今の状況を、話しやすいところから教えてください。' : 'Start wherever feels easiest: the goal, the current state, or a problem.'}</p></div>
        <button type="button" onClick={dismissGuide} aria-label={locale === 'ja' ? 'ヒントを閉じる' : 'Dismiss tip'}><X aria-hidden="true" /></button>
      </aside>}
      {startMode && <div className="composer-project-actions" aria-label={locale === 'ja' ? 'プロジェクトを選択' : 'Choose a project'}>
        <span>{registeredInactive
          ? (locale === 'ja' ? 'PROJECT / 停止中' : 'PROJECT / STOPPED')
          : (locale === 'ja' ? 'PROJECT / 未選択' : 'PROJECT / NOT SELECTED')}</span>
        <div>
          <button type="button" onClick={() => onNewProject?.(false)} disabled={!onNewProject || projectActionLocked}><Plus aria-hidden="true" />{locale === 'ja' ? '新規' : 'NEW'}</button>
          <button type="button" onClick={() => onStartFromFolder?.(false)} disabled={!onStartFromFolder || projectActionLocked}><FolderOpen aria-hidden="true" />{locale === 'ja' ? 'フォルダを開く' : 'OPEN FOLDER'}</button>
          {state.projects.length > 0 && <button type="button" onClick={() => onOpenProjects?.(false)} disabled={!onOpenProjects || projectActionLocked}>{locale === 'ja' ? '最近のプロジェクト' : 'RECENT PROJECTS'}</button>}
        </div>
      </div>}
      {projectPreparing && <div className="composer-project-actions is-pending" role="status">
        <span>{locale === 'ja' ? 'PROJECT / 準備中' : 'PROJECT / PREPARING'}</span>
        <p>{locale === 'ja'
          ? '統括者と会話履歴を読み込んでいます。入力欄は準備完了後に使えます。'
          : 'Loading the orchestrator and conversation history. The composer unlocks when preparation finishes.'}</p>
      </div>}
      {projectStopping && <div className="composer-project-actions is-pending" role="status">
        <span>{locale === 'ja' ? 'PROJECT / 停止中' : 'PROJECT / STOPPING'}</span>
        <p>{locale === 'ja'
          ? '実行中の処理を安全に終了しています。完了後に別のプロジェクトを開けます。'
          : 'Stopping active work safely. Another project can be opened after shutdown completes.'}</p>
      </div>}
      <div className="composer-body">
        <input
          key={fileInputGeneration}
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept={ATTACHMENT_PICKER_ACCEPT}
          multiple
          tabIndex={-1}
          onChange={onFileInputChange}
          aria-hidden="true"
        />
        <label className="sr-only" htmlFor="command-draft">{locale === 'ja' ? 'エージェントへの指示' : 'Instruction to agent'}</label>
        <textarea
          id="command-draft"
          value={state.draft}
          onChange={(event) => {
            if (fitsMessageTextPolicy(event.target.value)) store.setDraft(event.target.value);
          }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={onKeyDown}
          placeholder={projectPreparing
            ? (locale === 'ja' ? 'プロジェクトを準備しています…' : 'Preparing the project…')
            : projectStopping
              ? (locale === 'ja' ? 'プロジェクトを停止しています…' : 'Stopping the project…')
            : startMode
            ? (locale === 'ja' ? '何を作りたいか、どこから始めたいかを入力…' : 'Describe what you want to build or where you want to begin…')
            : (locale === 'ja' ? 'エージェントへ指示…' : 'Direct the agent…')}
          rows={3}
          maxLength={MESSAGE_TEXT_MAX_LENGTH_HINT}
          disabled={transitionLocked}
        />
        <div className="composer-action-row" ref={composerControlsRef}>
          <div className="composer-control composer-access-control">
            <button
              type="button"
              className={`composer-access-trigger is-${state.composerAccessMode}`}
              disabled={composerSettingsLocked}
              aria-haspopup="menu"
              aria-expanded={openComposerMenu === 'access'}
              onClick={() => setOpenComposerMenu((current) => current === 'access' ? null : 'access')}
            >
              <ShieldAlert aria-hidden="true" />
              <span>{state.composerAccessMode === 'full_access'
                ? (locale === 'ja' ? 'フルアクセス' : 'Full access')
                : (locale === 'ja' ? '承認あり' : 'Ask approval')}</span>
              <ChevronDown aria-hidden="true" />
            </button>
            {openComposerMenu === 'access' && <div className="composer-popover composer-access-menu" role="menu">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={state.composerAccessMode === 'approval_required'}
                onClick={() => { store.setComposerAccessMode('approval_required'); setOpenComposerMenu(null); }}
              >
                <span><b>{locale === 'ja' ? '承認あり' : 'Ask approval'}</b><small>{locale === 'ja' ? '必要な操作は実行前に確認' : 'Confirm sensitive actions before running'}</small></span>
                {state.composerAccessMode === 'approval_required' && <Check aria-hidden="true" />}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={state.composerAccessMode === 'full_access'}
                onClick={() => { store.setComposerAccessMode('full_access'); setOpenComposerMenu(null); }}
              >
                <span><b>{locale === 'ja' ? 'フルアクセス' : 'Full access'}</b><small>{locale === 'ja' ? '確認なしでPC内の操作を実行' : 'Run computer actions without confirmation'}</small></span>
                {state.composerAccessMode === 'full_access' && <Check aria-hidden="true" />}
              </button>
            </div>}
          </div>
          {voiceLive && <span className={`composer-voice-state phase-${state.voiceCapturePhase}`} role="status" aria-label={voiceLabel}>
            <span className="voice-waveform" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map((bar) => <i key={bar} />)}</span>
            {state.voiceCapturePhase === 'recording' && <time>{voiceElapsed(recordingSeconds)}</time>}
            <span className="sr-only">{voiceLabel}</span>
          </span>}
          <div className="composer-control composer-runtime-control">
            <button
              type="button"
              className="composer-runtime-trigger"
              disabled={composerSettingsLocked || !selectedModel}
              aria-haspopup="menu"
              aria-expanded={openComposerMenu === 'runtime'}
              aria-label={`${locale === 'ja' ? 'モデルと実行設定' : 'Model and runtime settings'}: ${modelLabel} ${effortLabel}`}
              onClick={() => setOpenComposerMenu((current) => current === 'runtime' ? null : 'runtime')}
            >
              {state.composerServiceTier === 'fast' && <Zap className="composer-fast-icon" aria-hidden="true" />}
              <span>{modelLabel}</span>
              <b>{effortLabel}</b>
              <ChevronDown aria-hidden="true" />
            </button>
            {openComposerMenu === 'runtime' && <div className="composer-popover composer-runtime-menu" role="menu">
              <button type="button" role="menuitem" onMouseEnter={() => openRuntimeSubmenu('model')} onMouseLeave={scheduleRuntimeSubmenuClose} onFocus={() => openRuntimeSubmenu('model')} onClick={() => openRuntimeSubmenu('model')}>
                <span>{locale === 'ja' ? 'モデル' : 'Model'}</span><b>{modelLabel}</b><ChevronRight aria-hidden="true" />
              </button>
              <button type="button" role="menuitem" onMouseEnter={() => openRuntimeSubmenu('effort')} onMouseLeave={scheduleRuntimeSubmenuClose} onFocus={() => openRuntimeSubmenu('effort')} onClick={() => openRuntimeSubmenu('effort')}>
                <span>{locale === 'ja' ? '推論レベル' : 'Reasoning'}</span><b>{effortLabel}</b><ChevronRight aria-hidden="true" />
              </button>
              <button type="button" role="menuitem" onMouseEnter={() => openRuntimeSubmenu('speed')} onMouseLeave={scheduleRuntimeSubmenuClose} onFocus={() => openRuntimeSubmenu('speed')} onClick={() => openRuntimeSubmenu('speed')}>
                <span>{locale === 'ja' ? '速度' : 'Speed'}</span><b>{state.composerServiceTier === 'fast' ? (locale === 'ja' ? '高速' : 'Fast') : (locale === 'ja' ? '標準' : 'Standard')}</b><ChevronRight aria-hidden="true" />
              </button>
              {runtimeSubmenu && <div className="composer-popover composer-runtime-submenu" role="menu" onMouseEnter={cancelRuntimeSubmenuClose} onMouseLeave={scheduleRuntimeSubmenuClose}>
                {runtimeSubmenu === 'model' && state.runtimeModels.map((model) => <button
                  key={model.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={model.id === state.composerModelId}
                  onClick={() => { store.selectComposerModel(model.id); setOpenComposerMenu(null); }}
                ><span><b>{compactModelLabel(model.displayName)}</b></span>{model.id === state.composerModelId && <Check aria-hidden="true" />}</button>)}
                {runtimeSubmenu === 'effort' && selectedModel?.supportedReasoningEfforts.map((effort) => <button
                  key={effort.effort}
                  type="button"
                  role="menuitemradio"
                  aria-checked={effort.effort === state.composerReasoningEffort}
                  onClick={() => { store.selectComposerReasoningEffort(effort.effort); setOpenComposerMenu(null); }}
                ><span><b>{reasoningEffortLabel(effort.effort, locale)}</b>{effort.description && <small>{effort.description}</small>}</span>{effort.effort === state.composerReasoningEffort && <Check aria-hidden="true" />}</button>)}
                {runtimeSubmenu === 'speed' && <>
                  <button type="button" role="menuitemradio" aria-checked={state.composerServiceTier === 'standard'} onClick={() => { store.setComposerServiceTier('standard'); setOpenComposerMenu(null); }}>
                    <span><b>{locale === 'ja' ? '標準' : 'Standard'}</b><small>{locale === 'ja' ? '標準速度' : 'Standard speed'}</small></span>{state.composerServiceTier === 'standard' && <Check aria-hidden="true" />}
                  </button>
                  <button type="button" role="menuitemradio" aria-checked={state.composerServiceTier === 'fast'} onClick={() => { store.setComposerServiceTier('fast'); setOpenComposerMenu(null); }}>
                    <span><b>{locale === 'ja' ? '高速' : 'Fast'}</b><small>{locale === 'ja' ? '1.5倍速・使用量多め' : '1.5x speed · higher usage'}</small></span>{state.composerServiceTier === 'fast' && <Check aria-hidden="true" />}
                  </button>
                </>}
              </div>}
            </div>}
          </div>
          <button
            type="button"
            className={`composer-action-icon attach-button${state.attachmentSelectionPending ? ' is-pending' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            disabled={!state.runtimeAuthority || state.sending || state.attachmentSelectionPending
              || state.attachmentRemovalPending
              || steerMode}
            aria-busy={state.attachmentSelectionPending}
            aria-label={locale === 'ja' ? 'ファイルを添付' : 'Attach files'}
          >{state.attachmentSelectionPending
              ? <LoaderCircle aria-hidden="true" />
              : <Paperclip aria-hidden="true" />}</button>
          <button
            type="button"
            data-native-effect="voice-capture"
            className={`composer-action-icon voice-button is-${state.voiceCapturePhase}${voiceAssetFailure ? ' has-setup-error' : ''}${!state.voiceStatus?.requiredAssetsReady ? ' needs-setup' : ''}`}
            onClick={onVoiceAction}
            disabled={!state.rendererAuthority || transitionLocked || state.sending
              || state.voiceCapturePhase === 'stopping' || state.voiceCapturePhase === 'cancelling'
              || voiceAssetBusy || voiceSetupBlocked}
            aria-busy={voiceAssetBusy || state.voiceCapturePhase === 'stopping'
              || state.voiceCapturePhase === 'cancelling'}
            aria-label={voiceLabel}
            title={voiceLabel}
          >{voiceAssetBusy || state.voiceCapturePhase === 'stopping'
              ? <LoaderCircle aria-hidden="true" />
              : state.voiceCapturePhase === 'recording'
                  ? <Square aria-hidden="true" />
              : state.voiceCapturePhase === 'requesting_permission' || state.voiceCapturePhase === 'transcribing'
                ? <X aria-hidden="true" />
                : state.voiceCapturePhase === 'cancelling'
                  ? <LoaderCircle aria-hidden="true" />
                : <Mic aria-hidden="true" />}</button>
          <button
            type="button"
            className={`composer-action-icon send-button${stopMode ? ' is-stop' : ''}`}
            disabled={stopMode
              ? !canStop
              : !canSend && !canStartProject && !canResumeProject && !canQueueVoiceSend}
            onClick={send}
            aria-label={primaryActionLabel}
            title={canStartProject
              ? (locale === 'ja' ? '新しいプロジェクトを作成して続行' : 'Create a new project and continue')
              : canResumeProject
                ? (locale === 'ja' ? '再開するプロジェクトを選択' : 'Choose a project to resume')
                : undefined}
          >
          <span className="sr-only">{primaryActionLabel}</span>
          {voiceSendIntentQueued
            ? <LoaderCircle aria-hidden="true" />
            : stopMode
              ? stopPending ? <LoaderCircle aria-hidden="true" /> : <Square aria-hidden="true" />
              : <Send aria-hidden="true" />}
        </button>
        </div>
      </div>
      {state.voiceError && <p className="composer-inline-error" role="alert">{userMessageCopy(state.voiceError, locale)}</p>}
      {steerBlocked && <p className="composer-steer-warning" role="alert">
        {locale === 'ja'
          ? '直前のターン操作が届いたか確認できないため、このターンへのStopと軌道修正を止めています。'
          : 'The previous turn mutation outcome is unknown, so Stop and Steer are blocked for this turn.'}
      </p>}
    </section>
  );
}
