<p align="center"><a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <b>日本語</b> | <a href="README.zh-CN.md">中文</a></p>

<div align="center">
  <img src="build/icon.png" width="160" alt="Illithid アイコン">
  <h1>Illithid</h1>
  <p><b>エージェントはそのまま。設定はひとつに。</b><br>
  Claude Code、Codex、OpenCode など、今使っているツールを使い続けながら、ルール、スキル、サブエージェント、MCP サーバーを一か所で管理できます。</p>

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

<table align="center">
  <tr>
    <td align="center"><img src="docs/agents/claude.svg" width="40" height="40" alt="Claude Code"><br>Claude Code</td>
    <td align="center"><img src="docs/agents/codex.svg" width="40" height="40" alt="Codex"><br>Codex</td>
    <td align="center"><img src="docs/agents/opencode.svg" width="40" height="40" alt="OpenCode"><br>OpenCode</td>
    <td align="center"><img src="docs/agents/gemini.svg" width="40" height="40" alt="Gemini CLI"><br>Gemini CLI</td>
    <td align="center"><img src="docs/agents/copilot.svg" width="40" height="40" alt="GitHub Copilot"><br>GitHub Copilot</td>
    <td align="center"><img src="docs/agents/grok.svg" width="40" height="40" alt="Grok CLI"><br>Grok CLI</td>
    <td align="center"><img src="docs/agents/qwen.svg" width="40" height="40" alt="Qwen Code"><br>Qwen Code</td>
  </tr>
</table>

## 一度設定して、各エージェントに同期

共有設定を一度編集し、変更をプレビューしてから使用するツールに反映できます。各ツールに適用するルール、スキル、サブエージェント、MCP サーバー、フック、権限を選べます。

<p align="center"><img src="docs/demo/rules.gif" width="960" alt="デモ: ルールを編集して 5 つのツールにプレビュー・反映"></p>

## 今の設定をそのままインポート

既存の設定を取り込み、使用するツールを選べます。適用前にすべての変更を確認でき、元のファイルは Illithid が管理を始める前にバックアップされます。

<p align="center"><img src="docs/demo/tools.gif" width="960" alt="Claude Code と一緒に Grok CLI をオンにし、Codex をオフにするときに片付く項目をプレビュー"></p>

## フックでチェックを自動化

フックを一度作れば、Claude Code、Codex、Gemini CLI、GitHub Copilot、Grok CLI、Qwen Code でそれぞれの形式で実行されます。実行するタイミングを選び、自分のスクリプトを実行するか、自然言語のルールで結果を確認できます。共有スクリプトはライブラリに置き、補助ファイルを含むフォルダとしても作れます。フックは macOS で動作し、Windows では当面ライブラリに保管されるだけです。

<p align="center"><img src="docs/demo/hooks.gif" width="960" alt="応答の終了時にテストが通るか確認する新しいフックを作り、ツールに反映"></p>

## エージェントが実行できるコマンドを決める

シェルコマンドの許可・確認・ブロックを一度決めれば、Illithid が Claude Code、Codex、Gemini CLI、GitHub Copilot、Qwen Code にそれぞれの形式でルールを書き込みます。関連するコマンドをグループにまとめ、特定のツールだけでルールをオフにできます。 MCP サーバーも同じように決められます。サーバーの権限タブで全ツールの既定値を決め、ツールごとに個別に変えると、Claude Code、Codex、Gemini CLI、OpenCode、Qwen Code に反映されます。

<p align="center"><img src="docs/demo/permissions.gif" width="960" alt="force push と hard reset をブロックし git status を許可する git グループを 4 つのツールに反映"></p>

## 使用履歴からモデルを比較

ローカルのセッションログから、モデル別のリクエスト数、トークン使用量、応答時間の中央値を比較できます。費用は公開 API のトークン単価で換算した値で、サブスクリプションの請求額とは異なります。ツールと期間で絞り込み、モデルと effort の組み合わせを比較できます。

<p align="center"><img src="docs/demo/stats.gif" width="960" alt="モデルごとの依頼あたりコストと応答時間、ツールの絞り込みと期間の一覧、1 つのモデルのコスト内訳"></p>

## インストール

```sh
brew install --cask doominkim/tap/illithid
```

または上のリンクから DMG をダウンロードしてください。

### Windows (ベータ)

[最新リリース](https://github.com/doominkim/illithid/releases/latest)から `illithid-x64-setup.exe` をダウンロードして実行してください(ARM PC では Windows の x64 エミュレーションで動作します)。インストーラーはまだコード署名されていないため、SmartScreen の警告が出ることがあります。**詳細情報 → 実行**を選んでください。

Windows 版はルール、スキル、サブエージェント、MCP サーバー、権限、既定のモデルを同期し、MCP のシークレットは Windows 資格情報マネージャーに保管します。フックはまだ Windows ではツールに書き込みません。

## その他の機能

- **マーケット**: ルール、スキル、MCP サーバーを検索してインストールできます。
- **セッション**: 過去の会話を検索し、作業を再開できます。
- **メモリ**: エージェントのメモリを見直し、共有ライブラリへ取り込めます。
- **成果物**: エージェントが作成したレポート、文書、画像をまとめて閲覧できます。
- **ワークスペースとバックアップ**: 設定を分けて管理し、エクスポートやインポート、Git バックアップを利用できます。GitHub でサインインして非公開のバックアップリポジトリを作るか、既存のリポジトリ URL を接続できます。[GitHub バックアップの設定](docs/github-backup.md)を参照してください。

## 安全なデフォルト

- **設定 → 使用中のツール** で選んだツールにだけ書き込み、反映の前にすべての変更をプレビューで表示します。
- 置き換えたファイルや削除したファイルは `~/.config/illithid/backups/` に移すだけで、消去しません。
- 古いバックアップは 30 日後にゴミ箱へ移します (期間は変更可能)。

## よくある質問

**コードやプロンプトは Illithid を経由しますか?**
いいえ。Illithid はどのモデル API とも通信しません。ローカルの設定ファイルを編集し、ローカルのセッションログを読むだけです。ネットワークを使うのは Git バックアップ（リモートを接続した場合のみ）、GitHub バックアップのサインインとリポジトリ設定（任意）、アップデートの確認、マーケットだけです。マーケットは skills.sh、公式 MCP レジストリ、GitHub にアクセスし、設定でオフにできます。新しいバージョンが出ているかも 1 日 1 回 GitHub に確認します。設定 → アップデートでオフにできます。

**既存の設定は上書きされますか?**
初回起動時に、今の設定をインポートするか確認します。インポートした元のファイルは、Illithid が管理を始める前にバックアップされます。

**使うのをやめるには?**
アプリを終了してアンインストールするだけです。Illithid が書いたのは普通のルール、スキル、設定項目なので、各ツールはそのまま動きます。1 つのツールだけ同期をやめるには、設定でそのツールをオフにします。片付く項目はプレビューに表示されます。

**Windows でも使えますか?**
はい、ベータとして対応しています。x64 PC の Windows 10・11 と、Windows 11 の ARM PC(x64 エミュレーション)で動作します。フックは当面 macOS のみで、それ以外はすべて同期されます。

## ソースからビルド

Node.js 22 以上が必要です。

```sh
npm install
npm run dev          # ホットリロードで起動
npm run build:mac    # dist/ に DMG を生成
npm run build:win    # dist/ に Windows インストーラーを生成 (Windows で実行)
```

Developer ID 証明書がない場合は `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac` で署名なしでビルドできます。

## アプリの言語

英語、韓国語、日本語、中国語。

## ライセンス

[MIT](LICENSE)
