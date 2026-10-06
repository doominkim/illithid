<p align="center"><b>English</b> | <a href="README.ko.md">한국어</a> | <a href="README.ja.md">日本語</a> | <a href="README.zh-CN.md">中文</a></p>

<div align="center">
  <img src="build/icon.png" width="160" alt="Illithid icon">
  <h1>Illithid</h1>
  <p><b>Your agents. One shared setup.</b><br>
  Keep using Claude Code, Codex, OpenCode, and more. Manage their rules, skills, subagents, and MCP servers in one place.</p>

  <p>
    <a href="https://github.com/doominkim/illithid/releases/latest"><img src="https://img.shields.io/github/v/release/doominkim/illithid?style=flat-square&label=download" alt="Download"></a>
    <img src="https://img.shields.io/badge/macOS-12%2B-blue?style=flat-square" alt="macOS 12+">
    <img src="https://img.shields.io/badge/Apple%20Silicon%20%7C%20Intel-lightgrey?style=flat-square" alt="Apple Silicon and Intel">
  </p>

  <p>
    <a href="https://github.com/doominkim/illithid/releases/latest/download/illithid-arm64.dmg">Download for Apple Silicon</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/doominkim/illithid/releases/latest/download/illithid-x64.dmg">Download for Intel</a>
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

## Configure once. Keep your agents in sync.

Edit your shared setup once, preview the changes, and apply them to the tools you use. Choose which rules, skills, subagents, MCP servers, hooks, and permissions each tool receives.

<p align="center"><img src="docs/demo/rules.gif" width="960" alt="Demo: edit a rule, preview the change and apply it to five tools"></p>

## Bring your existing setup.

Import the configuration you already use. Choose your tools and review every change before applying it. Imported originals are backed up before Illithid starts managing them.

<p align="center"><img src="docs/demo/tools.gif" width="960" alt="Turning Grok CLI on next to Claude Code, then previewing what leaves Codex when it is turned off"></p>

## Automate checks with hooks.

Write a hook once and it runs in Claude Code, Codex, Gemini CLI, GitHub Copilot, and Grok CLI, each in its own format. Pick when it runs, then run your own script or check the work with a plain-language rule. Keep shared scripts in the library; a script can be a folder with its own helper files.

<p align="center"><img src="docs/demo/hooks.gif" width="960" alt="A new hook that checks, when a reply finishes, that the tests pass, applied to the tools"></p>

## Decide which commands agents can run.

Allow, ask for, or block shell commands once, and Illithid writes the rule for Claude Code, Codex, Gemini CLI, and GitHub Copilot, each in its own format. Group related commands, and turn a rule off for a single tool. MCP servers get the same choices: in a server's Permissions tab, set a default for all its tools and override single tools, applied to Claude Code, Codex, Gemini CLI, and OpenCode.

<p align="center"><img src="docs/demo/permissions.gif" width="960" alt="A git group that blocks force pushes and hard resets and allows git status, applied to four tools"></p>

## Understand your model usage.

Compare request counts, token usage, and median response time from local session logs. See API-equivalent costs calculated from published token rates, separate from your subscription bill. Filter by tool and date range to compare model and effort combinations.

<p align="center"><img src="docs/demo/stats.gif" width="960" alt="Cost per request against response time by model, a tool filter, the period list and one model's cost breakdown"></p>

## Install

```sh
brew install --cask doominkim/tap/illithid
```

Or download the DMG above.

## Also included

- **Market**: discover and install rules, skills, and MCP servers.
- **Sessions**: search and resume past conversations.
- **Memory**: review and promote agent memories to the shared library.
- **Artifacts**: browse reports, documents, and images produced by your agents.
- **Workspaces & backup**: keep separate setups, export or import them, and back up the library with Git. Configured builds can sign in with GitHub and create a private backup repository; existing repository URLs remain supported. See [GitHub backup setup](docs/github-backup.md).

## Safe by default

- Illithid only writes to the tools you pick in **Settings → Tools in use**, and shows every change in a preview before applying it.
- Replaced or deleted files are moved to `~/.config/illithid/backups/`, never erased.
- Old backups go to the Trash after 30 days (configurable).

## FAQ

**Does my code or prompts go through Illithid?**
No. Illithid never talks to any model API. It edits local config files and reads local session logs. Network access includes Git backup (only if you connect a remote), optional GitHub backup sign-in and repository setup, the update check and the Market, which talks to skills.sh, the official MCP registry and GitHub. You can turn the Market off in Settings. Illithid also asks GitHub once a day whether a newer version is out; turn that off under Settings → Updates.

**Will it overwrite my existing setup?**
On first run Illithid offers to import what you have. Imported originals are backed up before Illithid takes them over.

**How do I stop using it?**
Quit the app and uninstall. The files it wrote are plain rules, skills and config entries, so your tools keep working. To stop syncing one tool, turn it off in Settings; the preview shows what Illithid removes from it.

**Why macOS only?**
Secrets are stored in the macOS Keychain, so only macOS builds are published for now.

## Build from source

Requires Node.js 22 or newer.

```sh
npm install
npm run dev          # run with hot reload
npm run build:mac    # DMGs in dist/
```

Without a Developer ID certificate, build unsigned with `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac`.

## App languages

English, Korean, Japanese and Chinese.

## License

[MIT](LICENSE)
