# Orquesta Desktop Home Tutorial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orquesta DesktopのHomeを、重要度順の7ページで日本語と英語の両方から説明できる、再実行可能なスポットライト式チュートリアルを実装する。

**Architecture:** チュートリアル本文と進行状態を純粋なmodelへ分け、Home部品には安定したtarget IDだけを付ける。最前面のReact overlayがtarget位置を測定してSVG maskを描き、DesktopRendererAppが手動開始、初回セットアップ完了時の自動開始、app-owned preferenceを結ぶ。

**Tech Stack:** React 19、TypeScript、CSS、Vitest、Testing Library、Electron renderer、localStorage

## Global Constraints

- ページは `map → composer → user-tasks → now → dock → project → luca` の7ページ固定とする。
- 日本語と英語は同じstep IDに対する正式なcopyとして同時に実装する。
- チュートリアル中は背景のHome操作を受け付けない。
- 歓迎専用ページと完了専用ページは追加しない。
- `prefers-reduced-motion: reduce` ではスポットライト移動を即時切り替えにする。
- preferenceはproject内へ書かず、key `orquesta.desktop.home-tutorial.v1` でDesktopのlocalStorageへ保存する。
- 完了またはスキップしたversionだけを保存し、途中位置は保存しない。
- 初回セットアップの画面、SetupEngine、六段階表示は変更しない。
- ブラウザは中間確認に限り、完成判定はElectron Desktopで行う。

---

### Task 1: 二言語step modelとpreferenceを実装する

**Files:**

- Create: `apps/orquesta-desktop/src/renderer/features/tutorial/home-tutorial-model.ts`
- Create: `apps/orquesta-desktop/tests/unit/home-tutorial-model.test.ts`

**Interfaces:**

- Produces: `HOME_TUTORIAL_VERSION = 1`
- Produces: `HOME_TUTORIAL_STEPS: readonly HomeTutorialStep[]`
- Produces: `readHomeTutorialPreference(storage: Storage): HomeTutorialPreference | null`
- Produces: `writeHomeTutorialPreference(storage: Storage, outcome: 'completed' | 'skipped', now?: Date): void`
- Produces: `shouldAutoStartHomeTutorial(previousStatus, nextStatus, preference): boolean`

- [ ] **Step 1: 7ページの順序、二言語copy、preference境界を固定する失敗テストを書く**

```ts
import { describe, expect, test } from 'vitest';
import {
  HOME_TUTORIAL_STEPS,
  readHomeTutorialPreference,
  shouldAutoStartHomeTutorial,
  writeHomeTutorialPreference
} from '../../src/renderer/features/tutorial/home-tutorial-model';

test('defines the same seven ordered pages in Japanese and English', () => {
  expect(HOME_TUTORIAL_STEPS.map((step) => step.id)).toEqual([
    'map', 'composer', 'user-tasks', 'now', 'dock', 'project', 'luca'
  ]);
  for (const step of HOME_TUTORIAL_STEPS) {
    expect(step.copy.ja.title.length).toBeGreaterThan(0);
    expect(step.copy.ja.body.length).toBeGreaterThan(0);
    expect(step.copy.en.title.length).toBeGreaterThan(0);
    expect(step.copy.en.body.length).toBeGreaterThan(0);
  }
});

test('stores only a completed or skipped version, not the current page', () => {
  localStorage.clear();
  writeHomeTutorialPreference(localStorage, 'skipped', new Date('2026-07-22T00:00:00.000Z'));
  expect(readHomeTutorialPreference(localStorage)).toEqual({
    version: 1, outcome: 'skipped', updatedAt: '2026-07-22T00:00:00.000Z'
  });
  expect(localStorage.getItem('orquesta.desktop.home-tutorial.v1')).not.toContain('step');
});

test('auto-starts only on an active setup to completed setup transition', () => {
  expect(shouldAutoStartHomeTutorial('running', 'completed', null)).toBe(true);
  expect(shouldAutoStartHomeTutorial(null, 'completed', null)).toBe(false);
  expect(shouldAutoStartHomeTutorial('running', 'completed', { version: 1, outcome: 'completed', updatedAt: '2026-07-22T00:00:00.000Z' })).toBe(false);
});
```

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/home-tutorial-model.test.ts`

Expected: `home-tutorial-model` が存在しないためFAIL。

- [ ] **Step 3: 型、7ページの日本語と英語、保存処理を実装する**

```ts
export const HOME_TUTORIAL_VERSION = 1 as const;
export const HOME_TUTORIAL_STORAGE_KEY = 'orquesta.desktop.home-tutorial.v1';

export type HomeTutorialStepId = 'map' | 'composer' | 'user-tasks' | 'now' | 'dock' | 'project' | 'luca';
export type HomeTutorialLocaleCopy = { title: string; body: string; points?: readonly string[] };
export type HomeTutorialStep = {
  id: HomeTutorialStepId;
  targetIds: readonly string[];
  copy: { ja: HomeTutorialLocaleCopy; en: HomeTutorialLocaleCopy };
};
export type HomeTutorialPreference = {
  version: 1;
  outcome: 'completed' | 'skipped';
  updatedAt: string;
};

export const HOME_TUTORIAL_STEPS: readonly HomeTutorialStep[] = [
  {
    id: 'map', targetIds: ['map'],
    copy: {
      ja: { title: 'Orquestaマップ', body: 'ここがOrquestaの組織図です。統括者、専門家、チーム、生産ラインを一つの地図として表示します。待機中のエージェントも含め、現在存在するエージェントはすべてここに残ります。', points: ['選択して役割・状態・担当作業を確認', 'ドラッグで移動、ホイールまたは上部ボタンで拡大', 'チーム管理は組織と一時監査の入口'] },
      en: { title: 'Orquesta map', body: 'This is the live organization map. It shows the orchestrator, specialists, teams, and production lines while keeping idle agents visible.', points: ['Select an agent or task for details', 'Drag to pan and use the wheel or top controls to zoom', 'Team Management opens roster and temporary inspections'] }
    }
  },
  {
    id: 'composer', targetIds: ['composer'],
    copy: {
      ja: { title: '統括者への入力', body: 'Orquestaへ指示や質問を送る場所です。通常は統括者へ送り、必要な専門家への分担は統括者が行います。送信できたことと、タスクが完了したことは別です。' },
      en: { title: 'Message the orchestrator', body: 'Send instructions or questions here. The orchestrator routes work to specialists. A sent message confirms dispatch, not task completion.' }
    }
  },
  {
    id: 'user-tasks', targetIds: ['user-tasks'],
    copy: {
      ja: { title: 'ユーザータスク', body: '質問、承認、確認、手作業など、あなたの対応を待っている項目だけを表示します。完了済みの項目はHomeへ残し続けません。' },
      en: { title: 'User Tasks', body: 'This area shows only items waiting for you: questions, approvals, reviews, and manual work. Completed items do not remain on Home.' }
    }
  },
  {
    id: 'now', targetIds: ['now'],
    copy: {
      ja: { title: '現在', body: '今まさに動いている、実行証拠のある作業を短く確認する場所です。未完了タスクのすべてや過去の履歴を並べる場所ではありません。' },
      en: { title: 'Now', body: 'See work that is actively running with execution evidence. This is not the full unfinished-task list or historical record.' }
    }
  },
  {
    id: 'dock', targetIds: ['dock'],
    copy: {
      ja: { title: '画面の切り替え', body: 'Homeは現在の全体像、ユーザータスクは自分の対応、記録はタスク・エラー・会話・判断・タイムライン、設定は表示・接続・起動・診断を扱います。' },
      en: { title: 'Switch workspaces', body: 'Home shows the current overview. User Tasks holds your actions. Records contains tasks, failures, conversations, decisions, and the timeline. Settings covers display, connection, startup, and diagnostics.' }
    }
  },
  {
    id: 'project', targetIds: ['project-launcher', 'project-status'],
    copy: {
      ja: { title: 'Project操作と状態', body: '左上からProjectを切り替えたりフォルダを開いたりできます。右上ではProject名、エージェント数、接続状態を確認できます。' },
      en: { title: 'Project controls and status', body: 'Use the top-left control to switch projects or open the folder. The top-right card shows the project name, agent count, and connection state.' }
    }
  },
  {
    id: 'luca', targetIds: ['luca'],
    copy: {
      ja: { title: 'Lucaに聞く', body: '何が起きているか分からないときはLucaへ聞けます。Lucaは現在の記録を説明する役であり、質問しただけでタスクや組織を変更しません。' },
      en: { title: 'Ask Luca', body: 'Ask Luca when the current state is unclear. Luca explains the available records and does not change tasks or the organization just because you asked.' }
    }
  }
];
```

`readHomeTutorialPreference` はJSON parse、version、outcome、ISO日時を検証し、不正値では`null`を返す。`shouldAutoStartHomeTutorial` は `previousStatus` が `preparing | running | paused | blocked`、`nextStatus` が `completed`、現在versionのpreferenceがない場合だけ`true`を返す。

- [ ] **Step 4: GREENを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/home-tutorial-model.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add apps/orquesta-desktop/src/renderer/features/tutorial/home-tutorial-model.ts apps/orquesta-desktop/tests/unit/home-tutorial-model.test.ts
git commit -m "feat(desktop): define bilingual Home tutorial"
```

### Task 2: Target計測とスポットライトoverlayを実装する

**Files:**

- Create: `apps/orquesta-desktop/src/renderer/features/tutorial/home-tutorial-targets.ts`
- Create: `apps/orquesta-desktop/src/renderer/features/tutorial/HomeTutorialOverlay.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/tutorial/home-tutorial.css`
- Create: `apps/orquesta-desktop/tests/unit/home-tutorial-overlay.test.tsx`

**Interfaces:**

- Consumes: `HomeTutorialStep`、`HomeTutorialStepId`
- Produces: `HOME_TUTORIAL_TARGET_ATTRIBUTE`
- Produces: `tutorialTargetProps(id): { 'data-orquesta-tutorial-target': string }`
- Produces: `measureTutorialTargets(document, ids): TutorialTargetRect[]`
- Produces: `HomeTutorialOverlay` props `{ stepIndex, locale, reducedMotion, onBack, onNext, onSkip }`

- [ ] **Step 1: spotlight、欠けたtarget、進行ボタン、二言語表示の失敗テストを書く**

```tsx
test('renders one mask hole for each present target and Japanese controls', () => {
  document.body.innerHTML = '<div data-orquesta-tutorial-target="project-launcher"></div><div data-orquesta-tutorial-target="project-status"></div>';
  for (const element of document.querySelectorAll('div')) {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 80, width: 100, height: 60, toJSON() {} });
  }
  render(<HomeTutorialOverlay stepIndex={5} locale="ja" reducedMotion={false} onBack={vi.fn()} onNext={vi.fn()} onSkip={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: 'Project操作と状態' })).toBeVisible();
  expect(screen.getAllByTestId('tutorial-hole')).toHaveLength(2);
  expect(screen.getByText('6 / 7')).toBeVisible();
  expect(screen.getByRole('button', { name: '戻る' })).toBeVisible();
  expect(screen.getByRole('button', { name: '次へ' })).toBeVisible();
});

test('uses English copy and labels the final action Complete', () => {
  document.body.innerHTML = '<button data-orquesta-tutorial-target="luca">Luca</button>';
  render(<HomeTutorialOverlay stepIndex={6} locale="en" reducedMotion onBack={vi.fn()} onNext={vi.fn()} onSkip={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: 'Ask Luca' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Complete' })).toBeVisible();
});
```

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/home-tutorial-overlay.test.tsx`

Expected: overlayとtarget計測が存在しないためFAIL。

- [ ] **Step 3: 安定したtarget IDと計測を実装する**

```ts
export const HOME_TUTORIAL_TARGET_ATTRIBUTE = 'data-orquesta-tutorial-target';

export function tutorialTargetProps(id: string) {
  return { [HOME_TUTORIAL_TARGET_ATTRIBUTE]: id } as Record<typeof HOME_TUTORIAL_TARGET_ATTRIBUTE, string>;
}

export function measureTutorialTargets(root: Document, ids: readonly string[]) {
  return ids.flatMap((id) => {
    const element = root.querySelector<HTMLElement>(`[${HOME_TUTORIAL_TARGET_ATTRIBUTE}="${id}"]`);
    if (!element) return [];
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? [{ id, left: rect.left, top: rect.top, width: rect.width, height: rect.height }] : [];
  });
}
```

- [ ] **Step 4: portal、SVG mask、説明カード、keyboard制御を実装する**

`HomeTutorialOverlay` は `createPortal(..., document.body)` を使う。maskは画面全体を白、target rectをpadding 8px付きの黒い角丸rectとして描く。overlay rootが全画面のpointer eventを受けるため背景操作を止める。カード内だけTab移動できるよう、最初と最後のfocusable element間を循環させる。Escapeは`onSkip`、ArrowLeftは`onBack`、ArrowRightは`onNext`を呼ぶ。

Targetが0件ならcomponent内で次の存在するstepを勝手に選ばず、`onNext`を一度呼ぶ。順序の責任をcontroller側へ残す。window resizeと`ResizeObserver`で再計測し、observerがないtest環境ではwindow resizeだけを使う。

- [ ] **Step 5: CSSを実装する**

`.home-tutorial-overlay` は `position: fixed; inset: 0; z-index: 5000;` とする。暗幕は `rgba(31, 30, 27, .62)`、枠は `rgba(104, 176, 145, .85)` と `rgba(255,255,255,.62)` の二重線にする。cardは既存Homeと同じ温かい紙色を使う。`@media (prefers-reduced-motion: reduce)` でtransitionとanimationを`none`にする。

- [ ] **Step 6: GREENを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/home-tutorial-overlay.test.tsx`

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add apps/orquesta-desktop/src/renderer/features/tutorial apps/orquesta-desktop/tests/unit/home-tutorial-overlay.test.tsx
git commit -m "feat(desktop): add Home tutorial spotlight"
```

### Task 3: Home targetと設定からの手動開始を接続する

**Files:**

- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/composer/CommandComposer.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/attention/AttentionCard.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/now/NowCardStack.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceDock.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/project/ProjectLauncher.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/project/ProjectStatusCard.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/settings/SettingsWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**

- Consumes: `tutorialTargetProps`
- Consumes: `HomeTutorialOverlay`
- Produces: `SettingsWorkspaceProps.onStartHomeTutorial(): void`
- Produces: Home内のtarget IDs `map`、`composer`、`user-tasks`、`now`、`dock`、`project-launcher`、`project-status`、`luca`

- [ ] **Step 1: 設定から開始し、7ページを日本語で進め、英語へ切り替えられる失敗テストを書く**

```tsx
test('starts the Home tutorial from Display settings and restores Home', async () => {
  const user = userEvent.setup();
  render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="ja" />);
  const navigation = await screen.findByRole('navigation', { name: 'ワークスペース' });
  await user.click(within(navigation).getByRole('button', { name: '設定' }));
  await user.click(screen.getByRole('button', { name: 'ホーム画面のチュートリアルを開始' }));

  expect(await screen.findByRole('dialog', { name: 'Orquestaマップ' })).toBeVisible();
  expect(screen.getByText('1 / 7')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '次へ' }));
  expect(screen.getByRole('dialog', { name: '統括者への入力' })).toBeVisible();
  expect(screen.getByLabelText('Orquesta map')).toBeVisible();
});

test('re-renders the active tutorial page in English after locale changes', async () => {
  const user = userEvent.setup();
  render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="ja" />);
  const navigation = await screen.findByRole('navigation', { name: 'ワークスペース' });
  await user.click(within(navigation).getByRole('button', { name: '設定' }));
  await user.click(screen.getByRole('button', { name: 'English' }));
  await user.click(screen.getByRole('button', { name: 'Start tutorial' }));
  expect(await screen.findByRole('dialog', { name: 'Orquesta map' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Next' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Skip' })).toBeVisible();
});
```

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/app.test.tsx -t "Home tutorial"`

Expected: 設定に開始操作がなくFAIL。

- [ ] **Step 3: 各Home componentの最外層へtarget IDを付ける**

各componentで `tutorialTargetProps` をimportし、既存class、aria、event handlerを変えずに最外層へ展開する。

```tsx
<section {...tutorialTargetProps('composer')} className="command-composer" aria-label="Command composer">
```

Project pageだけは `ProjectLauncher` に `project-launcher`、`ProjectStatusCard` に `project-status` を付ける。Lucaは`DesktopRendererApp`内の既存buttonへ`luca`を付ける。

- [ ] **Step 4: 設定の表示sectionへ再実行操作を追加する**

`SettingsWorkspaceProps`へ `onStartHomeTutorial(): void` を追加する。日本語copyは「ホーム画面のチュートリアル」「主要な場所と役割をもう一度確認します。」「チュートリアルを開始」、英語copyは「Home tutorial」「Review the main areas and what they are for.」「Start tutorial」とする。

開始buttonは既存の表示言語controlの下に置く。設定workspace上でbuttonを押したら、`DesktopRendererApp`が先にHomeへ戻し、次のanimation frameでtutorialを開始する。

- [ ] **Step 5: DesktopRendererAppへcontroller状態を追加する**

```ts
const [homeTutorialStep, setHomeTutorialStep] = useState<number | null>(null);
const startHomeTutorial = () => {
  setOverlay(null);
  setMapSelection(null);
  setActiveWorkspace('home');
  requestAnimationFrame(() => setHomeTutorialStep(0));
};
const finishHomeTutorial = (outcome: 'completed' | 'skipped') => {
  writeHomeTutorialPreference(window.localStorage, outcome);
  setHomeTutorialStep(null);
};
```

`homeTutorialStep !== null` のときだけ `HomeTutorialOverlay` を描画する。戻るは0未満へ進めず、次へは6ページ目で`completed`として閉じる。スキップは現在位置に関係なく`skipped`として閉じる。

- [ ] **Step 6: GREENを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/app.test.tsx -t "Home tutorial"`

Expected: PASS。

- [ ] **Step 7: 関連する既存component testを一回まとめて確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/app.test.tsx tests/unit/composer.test.tsx tests/unit/attention-card.test.tsx tests/unit/workspace-dock.test.tsx tests/unit/home-motion.test.tsx`

Expected: PASS。target属性以外の既存操作は変わらない。

- [ ] **Step 8: Commit**

```powershell
git add apps/orquesta-desktop/src/renderer apps/orquesta-desktop/tests/unit/app.test.tsx
git commit -m "feat(desktop): connect Home tutorial entry"
```

### Task 4: 初回セットアップ完了時の一度だけ自動開始とDesktop受入を追加する

**Files:**

- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`
- Create: `apps/orquesta-desktop/tests/e2e/home-tutorial.spec.ts`

**Interfaces:**

- Consumes: `shouldAutoStartHomeTutorial(previousStatus, nextStatus, preference)`
- Produces: setupの非完了状態から`completed`へ変わったときだけ自動開始するrenderer behavior

- [ ] **Step 1: setup transitionだけが自動開始する失敗テストを書く**

```tsx
test('auto-starts once when setup changes from running to completed', async () => {
  const bridge = new MockOrquestaBridge('setup-running');
  let publish!: (event: BridgeEvent) => void;
  vi.spyOn(bridge, 'subscribe').mockImplementation((listener) => { publish = listener; return () => undefined; });
  render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);
  await screen.findByText(/setup/i);

  const complete = structuredClone(fixtureCatalog['active-project'].snapshot);
  complete.setup = { ...fixtureCatalog['setup-running'].snapshot.setup!, status: 'completed', activePhaseId: 'operation' };
  act(() => publish({ type: 'snapshot_changed', snapshot: complete }));

  expect(await screen.findByRole('dialog', { name: 'Orquesta map' })).toBeVisible();
});

test('does not auto-start for an already completed project or after skip', async () => {
  const completedBridge = new MockOrquestaBridge('active-project');
  const completed = await completedBridge.getInitialSnapshot();
  completed.setup = { ...fixtureCatalog['setup-running'].snapshot.setup!, status: 'completed', currentPhaseId: null };
  vi.spyOn(completedBridge, 'getInitialSnapshot').mockResolvedValue(completed);
  const first = render(<DesktopRendererApp bridge={completedBridge} initialLocale="en" />);
  await screen.findByText('Demo data');
  expect(screen.queryByRole('dialog', { name: 'Orquesta map' })).not.toBeInTheDocument();
  first.unmount();

  writeHomeTutorialPreference(localStorage, 'skipped', new Date('2026-07-22T00:00:00.000Z'));
  const runningBridge = new MockOrquestaBridge('setup-running');
  let publish!: (event: BridgeEvent) => void;
  vi.spyOn(runningBridge, 'subscribe').mockImplementation((listener) => { publish = listener; return () => undefined; });
  render(<DesktopRendererApp bridge={runningBridge} initialLocale="en" />);
  await screen.findByText(/setup/i);
  act(() => publish({ type: 'snapshot_changed', snapshot: completed }));
  await screen.findByText('Demo data');
  expect(screen.queryByRole('dialog', { name: 'Orquesta map' })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/app.test.tsx -t "auto-starts once"`

Expected: setup transitionがtutorialへ接続されておらずFAIL。

- [ ] **Step 3: 直前のsetup statusをrefで保持し、自動開始条件を接続する**

snapshot変更を処理する直前に旧statusを読み、更新後のstatusとの組み合わせを`shouldAutoStartHomeTutorial`へ渡す。対象versionのpreferenceがある場合は開始しない。初期snapshotがすでにcompletedの場合も開始しない。

セットアップ担当の実装でstatus名が変わった場合は、このtaskで勝手に別名を増やさず、canonical `InitialSetupUiModel['status']`へ合わせてtestとhelperを同時に修正する。

- [ ] **Step 4: GREENを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/home-tutorial-model.test.ts tests/unit/home-tutorial-overlay.test.tsx tests/unit/app.test.tsx`

Expected: PASS。

- [ ] **Step 5: Electron acceptance testを書く**

`home-tutorial.spec.ts`はfake runtimeと`active-project` fixtureでDesktopを起動し、設定から手動開始する。次を一つのtestで確認する。

```ts
await page.getByRole('button', { name: 'Settings' }).click();
await page.getByRole('button', { name: 'Start tutorial' }).click();
await expect(page.getByRole('dialog', { name: 'Orquesta map' })).toBeVisible();
await expect(page.getByText('1 / 7')).toBeVisible();
await page.getByRole('button', { name: 'Next' }).click();
await expect(page.getByRole('dialog', { name: 'Message the orchestrator' })).toBeVisible();
await page.getByRole('button', { name: 'Skip' }).click();
await expect(page.getByRole('dialog')).toHaveCount(0);
```

- [ ] **Step 6: Desktop buildと受入を一回だけ実行する**

Run: `npm --prefix apps/orquesta-desktop run build`

Expected: TypeScript、Vite、Electron bundleが成功する。

Run: `npm --prefix apps/orquesta-desktop run test:e2e -- tests/e2e/home-tutorial.spec.ts`

Expected: Electron Desktop上でPASS。ブラウザだけの結果を完成証拠にしない。

- [ ] **Step 7: Commit**

```powershell
git add apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx apps/orquesta-desktop/tests/unit/app.test.tsx apps/orquesta-desktop/tests/e2e/home-tutorial.spec.ts
git commit -m "test(desktop): accept Home tutorial flow"
```

## Final verification

- [ ] `git diff --check` が成功する。
- [ ] `npm --prefix apps/orquesta-desktop run test -- tests/unit/home-tutorial-model.test.ts tests/unit/home-tutorial-overlay.test.tsx tests/unit/app.test.tsx` が成功する。
- [ ] `npm --prefix apps/orquesta-desktop run build` が成功する。
- [ ] Electron acceptanceで、日本語または英語の7ページ、スキップ、再実行の一経路を確認する。
- [ ] 初回セットアップ用worktreeのファイルを変更していないことを`git status`で確認する。
