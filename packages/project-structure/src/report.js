"use strict";

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderIssue(item) {
  const refs = item.source_refs.length > 0
    ? `\n  - 対象: ${item.source_refs.slice(0, 8).map((ref) => `\`${ref}\``).join(", ")}`
    : "";
  const count = Number.isInteger(item.details?.count) ? `（${item.details.count}件）` : "";
  return `- [${item.severity}] \`${item.code}\`${count}: ${item.message}${refs}`;
}

function renderShadowAuditReport({ inventory, audit, projection, layoutPath, lifecyclePath } = {}) {
  const components = Object.entries(inventory.stats.component_counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => `| \`${name}\` | ${count} |`)
    .join("\n");
  const issues = audit.issues.length > 0
    ? audit.issues.map(renderIssue).join("\n")
    : "- 問題は検出されなかった。";
  return `# Project Structure Phase 1 shadow audit

- 生成日時: ${inventory.generated_at}
- project: \`${inventory.project_id}\`
- manifest: \`${layoutPath}\`
- lifecycle: \`${lifecyclePath}\`

## 結論

この監査はshadow実行であり、既存ファイルの移動、削除、Context V2の切替、Desktop変更を行っていない。

監査状態: ${audit.blocked ? "正本または読取境界に要修正項目あり" : "hard blockerなし"}

## 集計

- 索引ファイル: ${inventory.stats.indexed_files}
- 索引容量: ${formatBytes(inventory.stats.indexed_bytes)}
- hash計測: ${inventory.stats.hashed_files}
- 大容量のためhash未計測: ${inventory.stats.unhashed_large_files}
- 未分類: ${inventory.stats.unclassified_files}
- 走査を省略した領域: ${inventory.stats.skipped_entries}
- 新しい読取候補: ${projection.stats.selected_files}
- 明示時だけ読む、または除外: ${projection.stats.excluded_files}
- 読取候補の概算token: ${projection.stats.selected_token_estimate}

## コンポーネント

| component | files |
|---|---:|
${components}

## 検出事項

${issues}

## この段階で行っていないこと

- ファイル移動
- ファイル削除
- lifecycleの本番有効化
- Source Catalog V2への接続
- specialist handoffの変更
- Desktop表示の変更

## 次の判断

まずmanifestの分類と検出事項をユーザーが確認する。承認後に段階2としてLifecycle ProjectionをContext V2の候補生成へ接続する。
`;
}

function renderLifecycleContextReport({ inventory, projection, audit, boundary, sourceCatalog, projectMap, projectMapView } = {}) {
  const exclusionCounts = {};
  for (const entry of boundary.exclusions) exclusionCounts[entry.reason] = (exclusionCounts[entry.reason] || 0) + 1;
  const exclusions = Object.entries(exclusionCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `| \`${reason}\` | ${count} |`)
    .join("\n") || "| なし | 0 |";
  const components = projectMap?.lifecycle_summary?.components || [];
  const componentRows = components
    .map((component) => `| \`${component.component_id}\` | ${component.indexed_sources} | ${component.candidate_sources} | ${component.excluded_sources} |`)
    .join("\n") || "| なし | 0 | 0 | 0 |";
  const canonicalErrors = boundary.canonical_claim_errors.length > 0
    ? boundary.canonical_claim_errors.map((entry) => `- \`${entry.code}\` / \`${entry.claim_key}\`: ${entry.source_refs.join(", ")}`).join("\n")
    : "- 競合なし";
  const effectiveSources = sourceCatalog.records.filter((record) => record.status === "current").length;
  const projectMapViewBytes = projectMapView
    ? Buffer.byteLength(`${JSON.stringify(projectMapView, null, 2)}\n`, "utf8")
    : 0;
  return `# Project Structure Phase 2 Context V2 shadow report

- 生成日時: ${inventory.generated_at}
- project: \`${inventory.project_id}\`

## 結論

Lifecycle ProjectionをContext V2のSource CatalogとProject Mapへshadow接続した。本番の\`.orquesta/context/source_catalog.json\`、既存Context Pack、物理ファイルは変更していない。

shadow状態: ${audit.blocked ? "blocked" : "ready"}

## 読取境界

- 索引ファイル: ${inventory.stats.indexed_files}
- lifecycle候補: ${projection.stats.selected_files}
- lifecycle除外: ${projection.stats.excluded_files}
- 有効なshadow Source Record: ${effectiveSources}
- 候補の概算token: ${projection.stats.selected_token_estimate}
- 既存catalogのcurrent source: ${boundary.previous_current_sources}
- Project Map: ${projectMap?.project_map_id || "未生成"}
- lifecycle overlay: ${projectMap?.lifecycle_overlay_id || "未生成"}
- 統括者向けProject Map View: ${projectMapView?.project_map_view_id || "未生成"} / ${formatBytes(projectMapViewBytes)} / 約${Math.ceil(projectMapViewBytes / 4)} token

ここでいう候補の概算tokenは、Source Catalogが検索できる全候補の合計であり、各エージェントへ一括投入する量ではない。初期読取には上記の短いProject Map Viewと、タスクごとに選ばれたContext Packだけを使う。

## 除外理由

| reason | files |
|---|---:|
${exclusions}

## 正本競合

${canonicalErrors}

## コンポーネント別の読取候補

| component | indexed | candidate | excluded |
|---|---:|---:|---:|
${componentRows}

## この段階で行っていないこと

- production Source Catalogの上書き
- Context Pack V2の本番切替
- ファイル移動または削除
- Desktop変更
`;
}

module.exports = { renderLifecycleContextReport, renderShadowAuditReport };
