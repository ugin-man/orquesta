# Orquesta Desktop Map group余白修正設計

日付: 2026-07-20

状態: ユーザー承認済み

## 目的

同じroleをまとめるgroup枠について、見出し、接続線、最上段agentが重なりかける問題を直す。zoomやagentの手動移動後も、group上部の余白を維持する。

今回は、保留中のツリー再設計に対する例外的な見た目修正である。Orquesta本体のrole、agent lifecycle、管理係、利用者連絡係、構想整理係、障害相談係、canonical state schemaは変更しない。

## 現在の原因

- 初期layoutではgroup上部に64 world pxを取るが、描画時の再計算で最上段agentの上42 world pxへ縮めている。
- group枠は最上段agentの移動に追従するが、見出しと接続線のための領域を別に確保していない。
- 枠と線はcamera zoomで変化する一方、group見出しの位置と文字サイズはscreen pxのままである。
- groupから最上段agentへの線がagent中央を終点にするため、node内部へ入り込む。

## 修正

- group paddingを左右52、上92、下44 world pxへ統一する。
- group枠は全agentのboundsと共通paddingから計算し、最上段agentを動かしても上92 world pxを維持する。
- groupからroot agentへ入る線は、agent中央ではなくnode上端を終点にする。
- group枠と見出しを一つのSVG groupへ入れ、同じcamera transformで拡大縮小する。
- group見出しは枠内の左上に置き、その下を接続線の通路として空ける。
- agent、group、線の既存自動配置、pan、zoom、Fit、Reset、手動配置保存は残す。

## 今回変更しないもの

- agentをMapへ出す条件
- foundation roleの統合や削除
- group分類規則
- organization parentのcanonical contract
- Team Managementの機能
- Map全体の配置アルゴリズム
- 長時間memory、pointer負荷測定

## 確認方法

実リポジトリを表示したDesktopアプリで次を確認する。

- IMPLEMENTATIONの見出しと実装係1の間に明確な余白がある
- 親からの線が見出しやagent名へ重ならない
- 拡大、縮小しても枠と見出しの比率が崩れない
- 実装係1を移動してもgroup上部の余白が残る
- Team Managementボタンとgroup枠が重ならない

この時点でユーザーへ渡す。role再編や全体Map再設計は続けて実装しない。
