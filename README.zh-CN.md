<p align="center"><a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.ja.md">日本語</a> | <b>中文</b></p>

<div align="center">
  <img src="build/icon.png" width="160" alt="Illithid 图标">
  <h1>Illithid</h1>
  <p><b>一个库，管理所有 AI 编程智能体。</b><br>
  规则、技能、子智能体和 MCP 服务器只需写一次。Illithid 会把它们同步到 Claude Code、Codex、OpenCode、Gemini CLI 等工具。</p>

  <p><sub>支持: Claude Code · Codex · OpenCode · Gemini CLI · GitHub Copilot · Grok CLI</sub></p>

  <p>
    <a href="https://github.com/doominkim/illithid/releases/latest"><img src="https://img.shields.io/github/v/release/doominkim/illithid?style=flat-square&label=download" alt="下载"></a>
    <img src="https://img.shields.io/badge/macOS-12%2B-blue?style=flat-square" alt="macOS 12+">
    <img src="https://img.shields.io/badge/Apple%20Silicon%20%7C%20Intel-lightgrey?style=flat-square" alt="Apple Silicon、Intel">
  </p>

  <p>
    <a href="https://github.com/doominkim/illithid/releases/latest/download/illithid-arm64.dmg">下载 Apple Silicon 版</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/doominkim/illithid/releases/latest/download/illithid-x64.dmg">下载 Intel 版</a>
  </p>
</div>

<p align="center"><img src="docs/demo/rules.gif" width="960" alt="演示: 编辑规则并预览后应用到 5 个工具"></p>

## 安装

```sh
brew install --cask doominkim/tap/illithid
```

也可以从上方链接下载 DMG。

## 为什么需要它

**每出一个新模型或编程智能体，就要重写一遍规则?**<br>
**每改一条规则，就要把所有智能体的配置挨个改一遍?**

每个工具的配置都放在不同位置: `~/.claude/`、`~/.codex/AGENTS.md`、`opencode.json`、`~/.gemini/`、`~/.copilot/`、`~/.grok/`。所以每次修改都要在好几个地方改同样的内容，还很容易有哪一处没跟上。

Illithid 把这一切集中在一个地方管理。规则改一次，所有工具同步生效；新增工具时，也能直接沿用你现有的配置。

Illithid 不运行模型，也不介入你和智能体之间。它只负责写配置文件，各工具照常工作。

## 功能

### 规则和技能，全工具生效

规则改一次，你使用的所有工具都会生效。也可以一键只在某个工具中关闭。

<p align="center"><img src="docs/demo/skills.gif" width="960" alt="只在 Gemini CLI 中关闭一个技能"></p>

### 子智能体，每个工具用合适的模型

一个子智能体定义，生成 Claude 的 `.md`、Codex 的 `.toml`、OpenCode 的 `.md`、Gemini CLI 的 `.md`、GitHub Copilot 的 `.agent.md` 和 Grok CLI 的 `.md`。各工具的模型和 effort 从列表中选择，无需手动输入 ID。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/agents-dark.png">
  <img src="docs/screenshots/agents-light.png" alt="按工具设置模型的子智能体">
</picture>

### 不泄露密钥的 MCP 服务器

无论 HTTP 还是 stdio，MCP 服务器只需添加一次。API 密钥保存在 macOS 钥匙串中，库里只保留引用。

打开技能或服务器，可查看最近 30 天智能体调用它的次数，按模型和工具统计。数据来自本地会话记录。

<p align="center"><img src="docs/demo/mcp.gif" width="960" alt="只在 GitHub Copilot 中关闭 MCP 服务器，并查看按模型统计的调用"></p>

### 市场

搜索 skills.sh 技能、MCP 注册表服务器和 awesome-copilot 规则，勾选需要的项目并安装到库中。安装的项目会带有市场标签。

<p align="center"><img src="docs/demo/market.gif" width="960" alt="从市场安装两个技能"></p>

### 所有会话，均可搜索

在一个列表中浏览 Claude Code、Codex、OpenCode、Gemini CLI、Grok CLI 的历史对话。可搜索标题或全文，跳转到任意消息，一键继续会话。

<p align="center"><img src="docs/demo/sessions.gif" width="960" alt="浏览过去会话中的请求"></p>

### 选择要用的工具

在 **设置 → 使用中的工具** 中开关工具。关闭某个工具时，确认预览后 Illithid 会从该工具中清理它放入的副本，你自己的文件保持不变。Grok CLI 和 GitHub Copilot 也会读取 Claude Code 的文件，因此同时开启时会先询问是否两者都用。

<p align="center"><img src="docs/demo/tools.gif" width="960" alt="与 Claude Code 一起开启 Grok CLI，再预览关闭 Codex 时会清理的项目"></p>

### 产出物集中管理

智能体生成的报告、文档和图片，按生成它们的工具分类展示。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/artifacts-dark.png">
  <img src="docs/screenshots/artifacts-light.png" alt="产出物">
</picture>

### 更多

- **工作区**: 把工作和个人等配置分开，一键切换。支持导出和导入 zip。
- **记忆**: 审阅 Claude 的自动记忆，有用的条目提升到共享库，其余移到废纸篓。
- **Git 备份**: 把库推送到私有仓库，并可恢复到任意快照。
- **导入**: 导入你已在使用的规则、技能、子智能体和 MCP 服务器。

## 默认安全

- 只写入你在 **设置 → 使用中的工具** 中选择的工具，应用前会在预览中列出所有改动。
- 被替换或删除的文件只会移到 `~/.config/illithid/backups/`，不会被清除。
- 旧备份在 30 天后移到废纸篓 (期限可调整)。

## 常见问题

**我的代码或提示词会经过 Illithid 吗?**
不会。Illithid 不与任何模型 API 通信。它只编辑本地配置文件、读取本地会话记录。网络访问仅限 Git 备份（仅在连接远程仓库时）和市场。市场会访问 skills.sh、官方 MCP 注册表和 GitHub，可在设置中关闭。

**会覆盖我现有的配置吗?**
首次启动时会询问是否导入现有配置。导入的原始文件在交由 Illithid 管理前会先备份。

**不想用了怎么办?**
退出并卸载应用即可。Illithid 写入的只是普通的规则、技能和配置项，各工具会继续正常工作。如果只想停止同步某个工具，在设置中关闭它即可，预览会列出将被清理的项目。

**为什么只支持 macOS?**
密钥保存在 macOS 钥匙串中，因此目前只发布 macOS 版本。

## 从源码构建

需要 Node.js 22 或更高版本。

```sh
npm install
npm run dev          # 热重载运行
npm run build:mac    # 在 dist/ 生成 DMG
```

没有 Developer ID 证书时，可用 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac` 构建未签名版本。

## 应用语言

英语、韩语、日语、中文。

## 许可证

[MIT](LICENSE)
