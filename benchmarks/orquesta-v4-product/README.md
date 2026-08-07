# Orquesta V4-fast 3条件ベンチマーク

同じ課題を、次の3条件で一回ずつ実行します。課題は一つに固定せず、
性質の異なる3種類を用意しています。

- `organization-json-generator`: Harbor Frameworkの公開`terminal-bench`課題を特定commitとSHA-256で固定した構造化データ生成
- `parallel-integration`: 複数ファイルにまたがるTypeScript実装修正
- `conflicting-requirements-triage`: 矛盾した製品・セキュリティ要件を検出し、未承認実装を止めてユーザー判断へ戻せるか

- `plain`: 使い捨ての`CODEX_HOME`を使う素のCodex。apps、memories、multi-agent、pluginsを無効にし、skillを置きません。
- `skills`: 普段の共通スキル環境を使うCodex。multi-agentは無効にし、課題workspaceにはOrquesta skillを置きません。
- `orquesta`: 共通スキルと、開始時に固定した開発中V4-fastスナップショットを使うOrquesta。

3条件は別々の課題workspaceとCodex App Serverプロセスで動きます。課題文、GPT-5.6 Sol、推論High、sandbox、approval policyは共通です。Orquesta内でV4-fastのモデル選択規則が別モデルを選んだ場合は、その実測値もthread別使用量へ残します。

## 実行順

```powershell
npm run benchmark:v4:test
npm run benchmark:v4:dry-run
npm run benchmark:v4:preflight
npm run benchmark:v4:run -- --matrix-id matrix-20260730-01
```

課題を変える場合は`--task`を指定します。`--mode`を省略すると従来通り
3条件を実行し、`--mode orquesta`なら現在のOrquestaだけを絞って実行します。

```powershell
npm run benchmark:v4:run -- `
  --matrix-id matrix-parallel-oos-01 `
  --task parallel-integration `
  --mode orquesta
```

段階Eの比較では、既定の`shadow`と、製品へ切り替えないベンチマーク限定の
`active`を別runで測れます。`active`は専門家の投入だけを新カーネルで制御し、
通常のDesktopやOrquesta経路は変更しません。

```powershell
npm run benchmark:v4:run -- `
  --matrix-id matrix-kernel-active-01 `
  --task parallel-integration `
  --mode orquesta `
  --kernel-mode active
```

`dry-run`はfixtureと偽のイベントだけを使います。Codexは起動しません。

`preflight`は小さな実Codex turnを3条件で一回ずつ実行します。認証、App Serverの独立性、適用model、sandbox、approval policy、workspace書き込み、公開課題ファイルのネット取得とSHA-256を確認します。一つでも失敗した場合、本番matrixは開始できません。

`run`は`plain`、`skills`、`orquesta`の順に実行します。同時実行しないので、PC負荷の重なりを避けられます。同じrun IDのディレクトリが一つでも存在する場合は、3条件とも開始しません。

matrix IDを省略すると時刻から自動生成します。保存先を変える場合は次のように指定できます。

```powershell
npm run benchmark:v4:run -- `
  --matrix-id matrix-20260730-01 `
  --storage-root C:\benchmark-output `
  --preflight benchmarks\orquesta-v4-product\.cache\preflight-latest.json `
  --output C:\benchmark-output\report.md
```

## 出力

- `runs/<matrix-id>-<mode>/result.json`: 条件ごとの確定結果
- `runs/<matrix-id>-<mode>/workspace.patch`: 課題workspaceの変更
- `workspaces/<matrix-id>-<mode>/`: 条件ごとの課題workspace
- `.cache/matrices/<matrix-id>/v4-fast/snapshot.json`: V4-fastの固定情報
- `reports/<matrix-id>.md`: 3条件比較

単一条件実行でも同じ`result.json`、workspace patch、token証拠を保存します。
単一条件のレポートは比較順位を出さず、その条件の実測値だけを記録します。

レポートには品質、実時間、uncached input、cached input、output、reasoning output、total token、thread、turn、handoff、review、correctionを分けて載せます。全条件がVerifierを通った場合だけ、速度とtokenの勝敗を直接比較します。

既存結果からレポートだけ作り直す場合は次を使います。

```powershell
npm run benchmark:v4:report -- `
  --runs-dir benchmarks\orquesta-v4-product\runs `
  --output benchmarks\orquesta-v4-product\reports\rebuilt.md
```

## V4-fastの扱い

公開tagではなく、実行開始時の開発ワークツリーを読み取り専用コピーへ固定します。記録するものはbase commit、tracked diff hash、untracked file hash、Orquesta skill hash、runtime tree hashです。ベンチマーク中に元の対象ファイルが変わった条件は`runtime_drift`で無効になります。

コピー対象はOrquesta、Codex adapter、core contracts、setup engine、必要なDesktop coreです。動画、レビュー用一時ファイル、ベンチマーク自身は含めません。元のV4-fastファイルへ書き戻しません。

## 時間制限

各App Server turnは15分でinterruptします。`plain`と`skills`は原則一turnです。Orquestaはfoundation準備、必要な専門家、統括者の最終turnがあるため、matrix全体を45分で必ず止める設計ではありません。実際のwall timeにはbootstrapも含めます。

## 証拠の限界

model、cwd、sandbox、approval policyはApp Serverが返した適用profileで確認します。reasoning effortはturn開始時の送信値です。skills、plugins、MCPの状態は、分離した`CODEX_HOME`、feature flag、課題workspaceの構成証拠です。App Serverが「実際に読んだskill一覧」を返すわけではないので、結果でもこの二つを同じ種類の証拠として扱いません。

session JSONLから集計するのはID、workspace、model、effort、tokenです。会話本文、tool output、`auth.json`の中身はベンチ結果へコピーしません。plain用認証は現在の`auth.json`へのハードリンクで、秘密ファイルの複製へ勝手に切り替えません。

過去の`solo`結果は`legacy_pilot`として残せますが、plainまたはskillsへ読み替えず、正式な3条件比較には混ぜません。
