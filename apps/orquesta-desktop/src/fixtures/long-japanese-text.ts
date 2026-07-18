import type { FixtureDefinition } from './types';
import { activeProjectFixture } from './active-project';

const fixture = structuredClone(activeProjectFixture);
fixture.snapshot.project = {
  ...fixture.snapshot.project,
  id: 'long-japanese-text',
  title: '複数の研究・設計・実装チームを横断して進行状況を整理する長い日本語プロジェクト名',
  rootPathLabel: '~/projects/長い日本語ラベル確認用プロジェクト',
  summary: '長い文字列でも中央マップの視認性と浮遊カードの役割分担を崩さないための確認状態',
  nextMilestone: '日本語表示でのオーバーフローと重なりを確認する'
};
fixture.snapshot.agents = fixture.snapshot.agents.map((agent, index) => index === 1 ? {
  ...agent,
  displayName: '業務横断データ分析担当者',
  roleSummary: '複数のデータソースを照合し矛盾点を説明する専門担当',
  currentTaskTitle: '複数部署から受け取った長い日本語の調査結果と実行証拠を比較し、矛盾点を整理してユーザーが判断できる材料をまとめる'
} : agent);
fixture.snapshot.tasks = fixture.snapshot.tasks.map((task, index) => index === 1 ? { ...task, title: '複数部署から受け取った長い日本語の調査結果と実行証拠を比較し、矛盾点を整理してユーザーが判断できる材料をまとめる', progressSummary: '一次資料と実行証拠を照合し、断定できない内容を不明として残しています。' } : task);
fixture.snapshot.attention = fixture.snapshot.attention.map((item, index) => index === 0 ? { ...item, summary: '分析範囲に含める対象期間と、参考資料として扱う情報の優先順位を確認してください。' } : item);
fixture.lastOpenedAt = '2026-07-17T12:10:00.000Z';

export const longJapaneseTextFixture: FixtureDefinition = fixture;
