# Setup Locale Consistency Design

## 目的

初回セットアップの入力画面から6段階の構築画面まで、現在選ばれている言語だけを表示する。英語時に日本語固定文を出さず、日本語時は現在の日本語体験を維持する。

## 方針

- 既存の `resolveInitialLocale` を唯一の初期言語判定として使う。
- `InitialSetupExperience`、`SetupOrganStage`、`SetupOrganScene` へ同じ `locale` を渡す。
- セットアップ専用辞書で段階名、状態、操作、進捗、ログ、WebGL代替文、読み上げ文を日英化する。
- 段階と既知の活動は安定IDから翻訳する。保存済みstateが日本語でも英語表示へ日本語を漏らさない。
- プロジェクト名、パス、ユーザー入力、実際のエラーメッセージは翻訳しない。
- 通常Homeやセットアップ後のプロジェクト記録は今回の対象外とする。

## 受け入れ条件

- `initialLocale="en"` の入力画面と6段階画面に日本語固定UIがない。
- `initialLocale="ja"` では既存の日本語表示を維持する。
- 英語Electronテストが `Start Orquesta` から英語の構築画面まで通る。
- セットアップ処理、状態保存、6段階の進行順は変更しない。
