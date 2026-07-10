# Orquesta Beta V3 QA

この手順は Beta V3 の状態ファイル、制御ロジック、外部UATの境界を確認するためのものです。初期化だけで実行済みのdispatch、turn、model、capacityの事実を作ってはいけません。

## Release commands

新しいcheckoutでは、まず次を実行します。既存の有効なデータは初期化で上書きされません。

```powershell
npm run test:beta-v3-state
npm run test:control-integration
npm run init:beta-v3-state
npm run check
npm run check:encoding
```

制御監査の現在値も確認する場合は、release ownerが次を別途実行します。このコマンドは監査スナップショットを書き換えるため、結果と時刻をrelease evidenceに残します。

```powershell
npm run audit:control
```

作業後はロックやatomic writeの残骸がないことも確認します。

```powershell
Get-ChildItem -Path .orquesta -Recurse -Force -File |
  Where-Object { $_.Name -match '\.(lock|tmp|bak|transition\.json)$' }
```

## Required current state

`npm run init:beta-v3-state` は共有atomic writerを通して、次の空のinboxを不足時だけ作ります。

```json
{ "version": 1, "actions": [] }
```

` .orquesta/state/dashboard_actions.json` はこの形です。

```json
{ "version": 1, "updated_at": null, "candidates": [] }
```

` .orquesta/failures/incident_candidates.json` はこの形です。

```json
{ "version": 1, "updated_at": null, "clusters": [] }
```

` .orquesta/failures/incident_clusters.json` はこの形です。

初期化は有効な既存ファイルを読み取りだけにします。JSONまたは最小schemaが壊れている場合は `BETA_V3_STATE_INVALID` で止まり、空ファイルで置き換えません。空のinboxは、未実施のユーザー対応、incident、dashboard action、dispatch、capacity、model実行の証拠ではありません。

## Integration evidence

`npm run test:control-integration` は一時ディレクトリだけを使います。次をまとめて確認します。

- staged completion envelopeの受理
- dispatch acceptedとturn startedの分離
- 繰り返すpre-start failureからのcircuit open、cooldown、probe
- fallback上限と互換性
- question observationのdedupeとVision Curatorへの未昇格
- incident fingerprint、open-only trigger、resolved/retired後の非trigger
- requested、applied、actual model evidenceの分離
- final control audit

このfixtureはlive threadのturn startやモデル適用を証明しません。実際のrelease acceptanceでは、対象task、report completion envelope、capacity evidence、control auditを別々に読みます。

## Compaction drill

コンテキストを引き継ぐ前に、次を読める状態にします。

```text
.orquesta/state/tasks.json
.orquesta/state/agents.json
.orquesta/state/sessions.json
.orquesta/state/capacity.json
.orquesta/state/control_audit.json
.orquesta/state/model_policy.json
.orquesta/vision/question_candidates.json
.orquesta/failures/incidents.json
.orquesta/failures/incident_candidates.json
.orquesta/failures/incident_clusters.json
.orquesta/reports/<task report>.md
```

引き継ぎでは、dispatchがacceptedだけか、turn_startedの証拠があるか、requested/applied/actual modelがどこまで証明されているか、開いているcircuitとcontrol audit findingを短く残します。ファイルが無いことや空であることから実行事実を補ってはいけません。

## External UAT and Browser boundary

T172の外部ユーザーUATは、次の画面確認に限ります。

- Control Planeが読めること
- 右側の間隔が崩れていないこと
- capacity detailを選べること
- capacity、audit、evidenceを切り替えられること
- Homeのpaused noticeから適切な画面へ移れること
- clipping、overflow、overlapがないこと
- unknown modelをactual modelのように表示しないこと

Codexのcrashが直るまで、この作業ではin-app Browserを使いません。Browser確認が無い状態で、画面UATやrelease acceptanceが通ったとは書きません。
