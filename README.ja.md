<p align="center"><a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <b>日本語</b> | <a href="README.zh-CN.md">中文</a></p>

<div align="center">
  <img src="build/icon.png" width="160" alt="Illithid アイコン">
  <h1>Illithid</h1>
  <p><b>すべての AI コーディングエージェントのための、ひとつのライブラリ。</b><br>
  ルール、スキル、サブエージェント、MCP サーバーは一度書くだけ。Claude Code、Codex、OpenCode などへ Illithid が同期します。</p>

  <p><sub>対応: Claude Code · Codex · OpenCode · Gemini CLI (予定)</sub></p>

  <p>
    <a href="https://github.com/doominkim/illithid/releases/latest"><img src="https://img.shields.io/github/v/release/doominkim/illithid?style=flat-square&label=download" alt="ダウンロード"></a>
    <img src="https://img.shields.io/badge/macOS-12%2B-blue?style=flat-square" alt="macOS 12+">
    <img src="https://img.shields.io/badge/Apple%20Silicon%20%7C%20Intel-lightgrey?style=flat-square" alt="Apple Silicon、Intel">
  </p>

  <p>
    <a href="https://github.com/doominkim/illithid/releases/latest/download/illithid-arm64.dmg">Apple Silicon 版をダウンロード</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/doominkim/illithid/releases/latest/download/illithid-x64.dmg">Intel 版をダウンロード</a>
  </p>
</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/rules-dark.png">
  <img src="docs/screenshots/rules-light.png" alt="Claude Code、Codex、OpenCode に同期されたルール">
</picture>

## インストール

```sh
brew install --cask doominkim/tap/illithid
```

または上のリンクから DMG をダウンロードしてください。

## なぜ Illithid か

**新しいモデルやコーディングエージェントが出るたびに、ルールを作り直していませんか?**<br>
**ルールを変えるたびに、すべてのエージェントの設定を手作業で直していませんか?**

ツールごとに設定の置き場所が違います。`~/.claude/`、`~/.codex/AGENTS.md`、`opencode.json`。そのため変更のたびに同じ内容を何か所も直すことになり、どこかがずれていきます。

Illithid はそれをすべて 1 か所で管理します。ルールを一度変えればすべてのツールに反映され、新しいツールも今の設定のまま始められます。

Illithid はモデルを実行せず、あなたとエージェントの間にも入りません。設定ファイルを書くだけで、各ツールはこれまでどおり動きます。

## 機能

### ルールとスキルを全ツールに

ルールを一度編集すれば、Claude Code、Codex、OpenCode のすべてに反映されます。特定のツールだけで無効にするのもワンクリックです。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/skills-dark.png">
  <img src="docs/screenshots/skills-light.png" alt="スキル">
</picture>

### ツールごとに最適なモデルを使うサブエージェント

ひとつのサブエージェント定義から、Claude の `.md`、Codex の `.toml`、OpenCode の `.md` を生成します。ツールごとのモデルと effort は、ID を入力せずリストから選べます。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/agents-dark.png">
  <img src="docs/screenshots/agents-light.png" alt="ツールごとのモデル設定を持つサブエージェント">
</picture>

### キーを漏らさない MCP サーバー

HTTP でも stdio でも、MCP サーバーの追加は一度だけ。API キーは macOS キーチェーンに保存され、ライブラリには参照だけが残ります。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/mcp-dark.png">
  <img src="docs/screenshots/mcp-light.png" alt="MCP サーバー">
</picture>

### すべてのセッションを検索

Claude Code、Codex、OpenCode の過去の会話をひとつのリストで表示します。タイトルや本文全体を検索し、任意のメッセージへ移動し、ワンクリックで再開できます。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/sessions-dark.png">
  <img src="docs/screenshots/sessions-light.png" alt="セッション">
</picture>

### 成果物をひとまとめに

エージェントが作ったレポート、ドキュメント、画像を、作成したツールごとに整理して表示します。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/artifacts-dark.png">
  <img src="docs/screenshots/artifacts-light.png" alt="成果物">
</picture>

### そのほか

- **ワークスペース**: 仕事用と個人用のように設定を分け、ワンクリックで切り替えます。zip でエクスポート、インポートできます。
- **メモリ**: Claude の自動メモリを見直し、役立つ項目は共有ライブラリへ、残りはゴミ箱へ。
- **Git バックアップ**: ライブラリを非公開リポジトリに push し、任意のスナップショットに戻せます。
- **インポート**: すでに使っているルール、スキル、サブエージェント、MCP サーバーを取り込みます。

## 安全なデフォルト

- 設定で **自動反映** をオンにするまで、ツールの設定ファイルには触れません。
- 置き換えたファイルや削除したファイルは `~/.config/illithid/backups/` に移すだけで、消去しません。
- 古いバックアップは 30 日後にゴミ箱へ移します (期間は変更可能)。

## よくある質問

**コードやプロンプトは Illithid を経由しますか?**
いいえ。Illithid はどのモデル API とも通信しません。ローカルの設定ファイルを編集し、ローカルのセッションログを読むだけです。ネットワークを使うのは Git バックアップだけで、リモートを接続した場合に限ります。

**既存の設定は上書きされますか?**
初回起動時に、今の設定をインポートするか確認します。インポートした元のファイルは、Illithid が管理を始める前にバックアップされます。

**使うのをやめるには?**
アプリを終了してアンインストールするだけです。Illithid が書いたのは普通のルール、スキル、設定項目なので、各ツールはそのまま動きます。

**なぜ macOS だけ?**
シークレットを macOS キーチェーンに保存するため、現在は macOS 版のみ配布しています。

## ソースからビルド

Node.js 22 以上が必要です。

```sh
npm install
npm run dev          # ホットリロードで起動
npm run build:mac    # dist/ に DMG を生成
```

Developer ID 証明書がない場合は `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac` で署名なしでビルドできます。

## アプリの言語

英語、韓国語、日本語、中国語。
