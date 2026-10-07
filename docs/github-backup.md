# GitHub backup sign-in

## Maintainer registration

Register one public [GitHub App](https://github.com/settings/apps/new) for Illithid users.

- Name: `Illithid Backup` (must be available).
- Homepage: `https://github.com/doominkim/illithid`.
- Enable Device Flow and expiring user authorization tokens.
- Leave callback/setup URLs empty and installation-time OAuth authorization unchecked.
- Disable webhooks.
- Grant **Contents: read and write** and **Administration: read and write** for repository creation. Metadata read is implicit. Leave other permissions disabled. If the registration UI offers the narrower **Repository creation: write**, prefer it instead of Administration.
- Allow installation on **Any account**.

See [registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) and [repository creation permissions](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user).

Official builds use the public Client ID `Iv23liRVxwaWmdfVT4oz` and app slug `illithid-backup` by default. Users do not need to register an app or configure environment variables. The public installation page is https://github.com/apps/illithid-backup.

For a separately registered development app, override the public Client ID and slug:

```sh
MAIN_VITE_GITHUB_APP_CLIENT_ID=YOUR_PUBLIC_CLIENT_ID \
MAIN_VITE_GITHUB_APP_SLUG=YOUR_APP_SLUG npm run build
```

For development, `ILLITHID_GITHUB_APP_CLIENT_ID` and `ILLITHID_GITHUB_APP_SLUG` are runtime alternatives. Do not provide a client secret or private key. Manual repository URL connection remains available.

## User flow

1. In Backup, choose **Set up GitHub backup** and enter the displayed code in GitHub.
2. Enter a repository name and confirm **Create backup repository**. Creation also attempts to connect it.
3. If permission is required, choose **Allow access in GitHub** and install the app with the intended repository access. Retry creation if it failed; if the repository was already created, choose **Finish setup** to connect without creating it again.
4. Choose **Back up now** to upload, or enable automatic backup.

**Connect an existing repository** accepts one repository URL. URLs on the signed-in personal GitHub account use the GitHub App; other URLs use existing Git credentials. After connection, the card shows the repository and connection status. To use another repository, choose **Disconnect**, confirm the local disconnection, then create or connect a repository from the setup screen. The remote repository and local library are kept. Organizations and GitHub Enterprise are not supported by GitHub sign-in.

## Credential handling

User and refresh tokens are encrypted with Electron `safeStorage` in the app's user-data directory, outside workspace backups. Linux plaintext storage is rejected. Sign-out clears the local credential; it does not revoke the installation on GitHub.

Authenticated Git commands receive a repository-scoped HTTP header only in the child environment. The token is excluded from command arguments, persisted Git config and renderer IPC. Failed authentication leaves the local snapshot intact and the upload pending.

## Verification boundary

Tests use synthetic GitHub responses, isolated app data and temporary Git repositories. A real Device Flow login, private repository creation, OS credential-store round trip and authenticated GitHub push/pull still require the registered app and a dedicated test repository.
