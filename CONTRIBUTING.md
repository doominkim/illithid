# Contributing to Illithid

Bug reports, documentation improvements, translations, and focused code changes are welcome.
Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/doominkim/illithid/issues) before opening a new one.
- Use the bug report or feature request form, and describe one problem per issue.
- Include the Illithid version, macOS version, processor architecture, affected tools and their versions, and steps to reproduce.
- Use synthetic examples. Redact tokens, credentials, personal paths, private repository names, and conversation content from attachments.
- Report suspected vulnerabilities through the [security policy](SECURITY.md), rather than a public bug report.

English is preferred for shared discussion. Reports in Korean, Japanese, or Chinese are also welcome.
For a substantial feature or a change to synchronization behavior, open an issue to discuss the approach before implementing it.

## Development setup

Use macOS 12 or newer and Node.js 22 or newer. Published builds support Apple Silicon and Intel.
The Electron app uses the macOS Keychain; use macOS for app development and validation.

Fork the repository, clone your fork, and create a branch for your change.

```sh
npm ci
npm run dev
```

The development app can read your local agent configuration and session files.
Use a separate macOS account with disposable agent configuration when testing import, apply, removal, or backup behavior.
Review the preview before applying changes.

## Repository layout

| Path                | Responsibility                                                               |
| ------------------- | ---------------------------------------------------------------------------- |
| `src/engine/`       | Configuration, synchronization, imports, backups, and local session scanning |
| `src/main/`         | Electron lifecycle and IPC handlers                                          |
| `src/preload/`      | Renderer bridge                                                              |
| `src/shared/`       | Shared API types and model definitions                                       |
| `src/renderer/src/` | React UI and translations                                                    |
| `scripts/`          | Tests, fixtures, and development utilities                                   |

## Making changes

- Keep pull requests focused on one change, and preserve existing user configuration.
- For behavior changes, first add a regression test that fails without the fix, then implement the change.
- Keep new fixtures isolated from real agent configuration and secrets.
- Write code comments and documentation in English.
- Put user-facing UI text in `src/renderer/src/i18n/`, and update all four language files: `en.json`, `ko.json`, `ja.json`, and `zh.json`.
- Use Conventional Commit subjects in English, such as `fix(sync): preserve unmanaged settings`.
- Avoid unrelated formatting, generated files, and dependency changes.

## Validation

CI runs on macOS with Node.js 22 and executes these checks after `npm ci`:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

Format only the files you changed with the repository's Prettier installation:

```sh
npx --no-install prettier --write path/to/changed-file
```

For app or packaging changes, also run `npm run build`.
For UI changes, check the affected screens and translations. `npm run test:ui` builds the app and runs Electron UI tests locally.
`npm run test:local` includes fixtures that copy configuration from the real home directory; review the scripts and use disposable data before running it.
Neither command runs in CI.

For documentation-only changes, check formatting and local links; app tests are usually unnecessary.
Record the commands you ran and their results in the pull request, including any checks you could not run.

## Pull requests

- Target `main` and complete the pull request template.
- Explain the problem, resulting behavior, and validation evidence. Link a related issue when available.
- Include redacted before/after screenshots or a short recording for visible UI changes.
- Call out changes that write to agent configuration, import data, or affect backups and secrets.
- Do not include private session logs, credentials, or signing certificates.

Contributions are made under the repository's [MIT license](LICENSE).
