<p align="center"><a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.ja.md">日本語</a> | <b>中文</b></p>

<div align="center">
  <img src="build/icon.png" width="160" alt="Illithid 图标">
  <h1>Illithid</h1>
  <p><b>继续使用你的智能体。统一管理配置。</b><br>
  继续使用 Claude Code、Codex、OpenCode 等现有工具，在一个地方管理规则、技能、子智能体和 MCP 服务器。</p>

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

<table align="center">
  <tr>
    <td align="center"><img src="docs/agents/claude.svg" width="40" height="40" alt="Claude Code"><br>Claude Code</td>
    <td align="center"><img src="docs/agents/codex.svg" width="40" height="40" alt="Codex"><br>Codex</td>
    <td align="center"><img src="docs/agents/opencode.svg" width="40" height="40" alt="OpenCode"><br>OpenCode</td>
    <td align="center"><img src="docs/agents/gemini.svg" width="40" height="40" alt="Gemini CLI"><br>Gemini CLI</td>
    <td align="center"><img src="docs/agents/copilot.svg" width="40" height="40" alt="GitHub Copilot"><br>GitHub Copilot</td>
    <td align="center"><img src="docs/agents/grok.svg" width="40" height="40" alt="Grok CLI"><br>Grok CLI</td>
  </tr>
</table>

## 配置一次，同步到各个智能体

编辑共享配置，预览改动，然后应用到你使用的工具。可以为每个工具选择启用哪些规则、技能、子智能体、MCP 服务器、钩子和权限。

<p align="center"><img src="docs/demo/rules.gif" width="960" alt="演示: 编辑规则并预览后应用到 5 个工具"></p>

## 导入现有配置

导入你已在使用的配置，并选择需要管理的工具。应用前可以查看所有改动，原始文件会在交由 Illithid 管理前备份。

<p align="center"><img src="docs/demo/tools.gif" width="960" alt="与 Claude Code 一起开启 Grok CLI，再预览关闭 Codex 时会清理的项目"></p>

## 用钩子自动检查

钩子只需写一次，就会以各自的格式在 Claude Code、Codex、Gemini CLI、GitHub Copilot 和 Grok CLI 中运行。选择运行时机，然后运行你自己的脚本，或用自然语言规则检查结果。共用的脚本放在库中，也可以是带辅助文件的文件夹。

<p align="center"><img src="docs/demo/hooks.gif" width="960" alt="新建一个在回复结束时检查测试是否通过的钩子，并应用到各工具"></p>

## 决定智能体可以运行哪些命令

只需设置一次允许、询问或阻止哪些 shell 命令，Illithid 会以各自的格式为 Claude Code、Codex、Gemini CLI 和 GitHub Copilot 写入规则。可以把相关命令分组，也可以只在某个工具中关闭某条规则。

<p align="center"><img src="docs/demo/permissions.gif" width="960" alt="一个阻止强制推送和硬重置、允许 git status 的 git 分组，应用到 4 个工具"></p>

## 根据使用记录比较模型

根据本地会话记录比较各模型的请求数、令牌用量和响应时间中位数。费用按公开的 API 令牌单价换算，与订阅账单不同。按工具和日期范围筛选，比较模型与 effort 的组合。

<p align="center"><img src="docs/demo/stats.gif" width="960" alt="按模型比较每个请求的成本和响应时间，工具筛选与时间范围列表，以及一个模型的成本明细"></p>

## 安装

```sh
brew install --cask doominkim/tap/illithid
```

也可以从上方链接下载 DMG。

## 其他功能

- **市场**：搜索并安装规则、技能和 MCP 服务器。
- **会话**：搜索过去的对话并继续工作。
- **记忆**：审阅智能体记忆，并提升到共享库。
- **产物**：集中查看智能体生成的报告、文档和图片。
- **工作区与备份**：分开管理配置，导出或导入，并通过 Git 备份配置库。

## 默认安全

- 只写入你在 **设置 → 使用中的工具** 中选择的工具，应用前会在预览中列出所有改动。
- 被替换或删除的文件只会移到 `~/.config/illithid/backups/`，不会被清除。
- 旧备份在 30 天后移到废纸篓 (期限可调整)。

## 常见问题

**我的代码或提示词会经过 Illithid 吗?**
不会。Illithid 不与任何模型 API 通信。它只编辑本地配置文件、读取本地会话记录。网络访问仅限 Git 备份（仅在连接远程仓库时）、更新检查和市场。市场会访问 skills.sh、官方 MCP 注册表和 GitHub，可在设置中关闭。Illithid 还会每天向 GitHub 查询一次是否有新版本，可在设置 → 更新中关闭。

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
