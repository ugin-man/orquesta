import { useEffect, useMemo, useState } from 'react';
import { Check, FolderOpen, Github, LoaderCircle, LogIn, MapPin, Plus, ShieldCheck } from 'lucide-react';
import type { OrquestaRendererBridge } from '../../../contracts/bridge';
import { isSetupDraft, type SetupAccountState, type SetupDraft, type SetupSourceDraft } from '../../../contracts/setup';
import type { Locale } from '../i18n/messages';
import './setup-intake.css';

type SourceMode = SetupSourceDraft['kind'] | 'none';

function sourceLabel(source: SetupSourceDraft): string {
  if (source.kind === 'detected_root' || source.kind === 'existing_folder') return source.rootPath;
  if (source.kind === 'new_project') return `${source.parentPath}\\${source.folderName}`;
  return `${source.repositoryUrl} → ${source.parentPath}`;
}

function githubUrlValid(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com'
      && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/u.test(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parentFromSource(source: SetupSourceDraft): string {
  if (source.kind === 'new_project' || source.kind === 'public_github') return source.parentPath;
  return source.rootPath;
}

function safeFolderName(name: string): string {
  const normalized = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/[. ]+$/u, '');
  return normalized.slice(0, 128) || 'New Orquesta Project';
}

function accountText(account: SetupAccountState, ja: boolean): string {
  if (account.status === 'checking') return ja ? '接続を確認中' : 'Checking connection';
  if (account.status === 'authenticated') {
    if (account.accountType === 'api_key') return ja ? 'API keyで接続済み' : 'Connected with API key';
    return ja ? 'ChatGPTで接続済み' : 'Connected with ChatGPT';
  }
  if (account.status === 'unauthenticated') return ja ? 'ログインが必要です' : 'Sign in required';
  return ja ? '接続を確認できません' : 'Connection unavailable';
}

export function SetupIntake({ bridge, locale }: { bridge: OrquestaRendererBridge; locale: Locale }) {
  const ja = locale === 'ja';
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>('none');
  const [githubUrl, setGithubUrl] = useState('');
  const [githubParent, setGithubParent] = useState('');
  const [account, setAccount] = useState<SetupAccountState>({ status: 'checking', accountType: null, requiresOpenaiAuth: null });
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([bridge.readSetupDraft(), bridge.readSetupAccount()]).then(([nextDraft, nextAccount]) => {
      if (!alive) return;
      setDraft(nextDraft);
      setSourceMode(nextDraft?.source.kind ?? 'none');
      if (nextDraft?.source.kind === 'public_github') {
        setGithubUrl(nextDraft.source.repositoryUrl);
        setGithubParent(nextDraft.source.parentPath);
      } else if (nextDraft) {
        setGithubParent(parentFromSource(nextDraft.source));
      }
      setAccount(nextAccount);
      setLoading(false);
    }).catch((error: unknown) => {
      if (!alive) return;
      setNotice(error instanceof Error ? error.message : String(error));
      setLoading(false);
    });
    return () => { alive = false; };
  }, [bridge]);

  const effectiveDraft = useMemo<SetupDraft | null>(() => {
    if (!draft) return null;
    if (sourceMode !== 'public_github') return draft;
    return { ...draft, source: { kind: 'public_github', repositoryUrl: githubUrl.trim(), parentPath: githubParent.trim() } };
  }, [draft, githubParent, githubUrl, sourceMode]);

  const validDraft = Boolean(effectiveDraft && isSetupDraft(effectiveDraft));
  const authenticated = account.status === 'authenticated';
  const canStart = validDraft && authenticated && !working;

  useEffect(() => {
    if (!effectiveDraft || !isSetupDraft(effectiveDraft)) return;
    const timeout = window.setTimeout(() => {
      void bridge.saveSetupDraft(effectiveDraft).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [bridge, effectiveDraft]);

  const choose = async (kind: SetupSourceDraft['kind']) => {
    setNotice(null);
    if (kind === 'public_github') {
      setSourceMode(kind);
      if (draft) setGithubParent((current) => current || parentFromSource(draft.source));
      return;
    }
    setWorking(true);
    try {
      const source = await bridge.chooseSetupSource(kind);
      if (!source) {
        setNotice(ja ? '場所は変更されませんでした。' : 'The source was not changed.');
        return;
      }
      const projectName = source.kind === 'existing_folder' || source.kind === 'detected_root'
        ? source.rootPath.split(/[\\/]/u).filter(Boolean).at(-1) || draft?.projectName || 'Orquesta Project'
        : source.kind === 'new_project'
          ? draft?.projectName || source.folderName
          : draft?.projectName || new URL(source.repositoryUrl).pathname.split('/').filter(Boolean).at(-1) || 'GitHub Project';
      const next: SetupDraft = {
        revision: 1, status: 'draft', source, projectName, description: draft?.description ?? '',
        questions: draft?.questions ?? [], answers: draft?.answers ?? []
      };
      setDraft(next);
      setSourceMode(kind);
      setGithubParent(parentFromSource(source));
      await bridge.saveSetupDraft(next);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  const updateDraft = (patch: Partial<Pick<SetupDraft, 'projectName' | 'description' | 'answers'>>) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      if (next.source.kind === 'new_project' && patch.projectName !== undefined) {
        next.source = { ...next.source, folderName: safeFolderName(patch.projectName) };
      }
      return next;
    });
  };

  const login = async () => {
    setWorking(true);
    setNotice(null);
    try {
      await bridge.startSetupLogin();
      setNotice(ja ? 'ブラウザでログインを完了してください。' : 'Complete sign-in in your browser.');
      setAccount(await bridge.readSetupAccount());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  const start = async () => {
    if (!effectiveDraft || !canStart) return;
    setWorking(true);
    setNotice(null);
    try {
      await bridge.saveSetupDraft(effectiveDraft);
      await bridge.startSetup(effectiveDraft);
      setNotice(ja ? 'セットアップを開始しました。' : 'Setup started.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      setWorking(false);
    }
  };

  if (loading) {
    return <main className="setup-intake setup-intake--loading"><LoaderCircle className="setup-intake__spinner" />{ja ? '準備中…' : 'Preparing…'}</main>;
  }

  const answered = effectiveDraft?.answers.filter((answer) => answer.answer.trim()).length ?? 0;
  const questionCount = effectiveDraft?.questions.length ?? 0;
  return (
    <main className="setup-intake" role="application" aria-label="Orquesta Desktop setup">
      <div className="setup-intake__paper" aria-hidden="true" />
      <header className="setup-intake__header"><span><i /> ORQUESTA DESKTOP</span><p>LOCAL MULTI-AGENT WORKSPACE</p></header>
      <section className="setup-intake__intro">
        <p>INITIAL SETUP</p><h1>{ja ? 'Orquestaを始める' : 'Start Orquesta'}</h1>
        <small>{ja ? '入力、Codex接続、開始確認をこの一枚で完了します。開始するまではプロジェクトへ書き込みません。' : 'Choose a project, confirm Codex, and approve setup on this screen. Nothing is written to the project before Start.'}</small>
      </section>

      <section className="setup-intake__panel setup-intake__source" aria-labelledby="setup-source-title">
        <div className="setup-intake__section-title"><span>01</span><div><h2 id="setup-source-title">{ja ? 'プロジェクト' : 'Project'}</h2><p>{ja ? 'どこから始めるか選びます' : 'Choose where to begin'}</p></div></div>
        <div className="setup-intake__source-actions">
          <button type="button" className={sourceMode === 'detected_root' ? 'is-selected' : ''} onClick={() => void choose('detected_root')}><MapPin size={17} /><span>{ja ? 'この場所で始める' : 'Use detected project'}</span></button>
          <button type="button" className={sourceMode === 'existing_folder' ? 'is-selected' : ''} onClick={() => void choose('existing_folder')}><FolderOpen size={17} /><span>{ja ? '既存フォルダを選ぶ' : 'Choose existing folder'}</span></button>
          <button type="button" className={sourceMode === 'new_project' ? 'is-selected' : ''} onClick={() => void choose('new_project')}><Plus size={17} /><span>{ja ? '新しいプロジェクト' : 'New project'}</span></button>
          <button type="button" className={sourceMode === 'public_github' ? 'is-selected' : ''} onClick={() => void choose('public_github')}><Github size={17} /><span>{ja ? 'GitHubから始める' : 'Start from GitHub'}</span></button>
        </div>
        {sourceMode === 'public_github' ? (
          <fieldset className="setup-intake__github" aria-label={ja ? 'GitHubリポジトリ' : 'GitHub repository'}>
            <label>{ja ? '公開GitHub URL' : 'Public GitHub URL'}<input aria-label={ja ? '公開GitHub URL' : 'Public GitHub URL'} value={githubUrl} onChange={(event) => setGithubUrl(event.target.value)} placeholder="https://github.com/owner/repository" /></label>
            <label>{ja ? '保存先' : 'Destination'}<input aria-label={ja ? '保存先' : 'Destination'} value={githubParent} onChange={(event) => setGithubParent(event.target.value)} /></label>
            <p className={githubUrl && !githubUrlValid(githubUrl) ? 'is-error' : ''}>{ja ? '公開HTTPSリポジトリのみ。private、Git LFS、submoduleは、取得済みフォルダを選んでください。' : 'Public HTTPS repositories only. For private repositories, Git LFS, or submodules, choose an already downloaded folder.'}</p>
          </fieldset>
        ) : effectiveDraft ? <div className="setup-intake__path"><Check size={14} />{sourceLabel(effectiveDraft.source)}</div> : null}
      </section>

      <section className="setup-intake__panel setup-intake__details" aria-labelledby="setup-details-title">
        <div className="setup-intake__section-title"><span>02</span><div><h2 id="setup-details-title">{ja ? 'プロジェクト情報' : 'Project details'}</h2><p>{ja ? '説明と補完情報' : 'Description and context'}</p></div></div>
        <label>{ja ? 'プロジェクト名' : 'Project name'}<input aria-label={ja ? 'プロジェクト名' : 'Project name'} value={draft?.projectName ?? ''} maxLength={128} onChange={(event) => updateDraft({ projectName: event.target.value })} /></label>
        <label>{ja ? '説明' : 'Description'}<textarea aria-label={ja ? '説明' : 'Description'} value={draft?.description ?? ''} maxLength={16384} onChange={(event) => updateDraft({ description: event.target.value })} placeholder={ja ? '任意。空欄でも開始できます。' : 'Optional. You can start without it.'} /></label>
        {draft?.questions.map((question) => {
          const value = draft.answers.find((answer) => answer.questionId === question.questionId)?.answer ?? '';
          return <label key={question.questionId}>{question.prompt}<input aria-label={question.prompt} value={value} onChange={(event) => {
            const answers = draft.answers.filter((answer) => answer.questionId !== question.questionId);
            updateDraft({ answers: [...answers, { questionId: question.questionId, answer: event.target.value }] });
          }} /><small>{ja ? '任意。未回答のまま続行できます。' : 'Optional. You may leave this unanswered.'}</small></label>;
        })}
      </section>

      <section className="setup-intake__panel setup-intake__approval" aria-label={ja ? '開始前の確認' : 'Setup summary'}>
        <div className="setup-intake__section-title"><span>03</span><div><h2>{ja ? '接続と開始' : 'Connect and start'}</h2><p>{ja ? '最後の確認' : 'Final approval'}</p></div></div>
        <div className={`setup-intake__account setup-intake__account--${account.status}`}><ShieldCheck size={20} /><div><strong>{accountText(account, ja)}</strong>{account.status === 'unavailable' ? <small>{account.reason}</small> : null}</div></div>
        {account.status !== 'authenticated' ? <button type="button" className="setup-intake__login" onClick={() => void login()} disabled={working}><LogIn size={16} />{ja ? 'ChatGPTでログイン' : 'Sign in with ChatGPT'}</button> : null}
        <dl className="setup-intake__summary">
          <div><dt>{ja ? '対象' : 'Target'}</dt><dd>{effectiveDraft ? sourceLabel(effectiveDraft.source) : '—'}</dd></div>
          <div><dt>{ja ? '基礎エージェント' : 'Foundation agents'}</dt><dd>{ja ? '3体' : '3'}</dd></div>
          <div><dt>{ja ? '補完質問' : 'Optional questions'}</dt><dd>{answered} / {questionCount}</dd></div>
        </dl>
        <p className="setup-intake__approval-note">{ja ? '統括者、Luca、利用者支援係を構築し、その後プロジェクトに必要な専門家を編成します。' : 'Creates the orchestrator, Luca, and user support, then forms project-specific specialists.'}</p>
        <button type="button" className="setup-intake__start" disabled={!canStart} onClick={() => void start()}>{working ? <LoaderCircle className="setup-intake__spinner" size={17} /> : <Check size={17} />}{ja ? 'セットアップを開始' : 'Start setup'}</button>
        {!authenticated ? <small className="setup-intake__blocked">{ja ? '開始するにはOpenAIへの接続が必要です。入力内容は保持されます。' : 'Connect to OpenAI before starting. Your input is preserved.'}</small> : null}
      </section>
      {notice ? <p className="setup-intake__notice" role="status">{notice}</p> : null}
    </main>
  );
}
