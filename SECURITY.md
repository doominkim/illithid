# Security Policy

## Supported versions

Security fixes target the [latest published release](https://github.com/doominkim/illithid/releases/latest).
Older versions do not have a separate security maintenance track; you may be asked to update before a report can be reproduced.

## Reporting a vulnerability

Do not post vulnerability details, exploit code, credentials, or private configuration in public issues or pull requests.

1. Open the repository's [Security advisories page](https://github.com/doominkim/illithid/security/advisories).
2. If **Report a vulnerability** is available, use it to submit a private report.
3. If it is unavailable, [open an issue](https://github.com/doominkim/illithid/issues/new) titled "Private security contact request" with only this message:

   > I would like a private channel to report a potential security issue.

The fallback contact request is public. Do not include the affected component, reproduction steps, impact, attachments, or sensitive data in that request.
Wait for the maintainer to arrange a private reporting channel before sharing details.

In the private report, include:

- Illithid version, macOS version, and processor architecture.
- Affected coding agents and their versions, if relevant.
- A description of the issue, expected behavior, and potential impact.
- Minimal reproduction steps using synthetic data.
- Redacted evidence and any proposed fix, if available.

Do not send live tokens, passwords, signing keys, real session logs, or complete agent configuration files.
If a credential was exposed, revoke or rotate it through its provider independently of this report.

## Relevant areas

Illithid reads local configuration and session records, writes selected agent settings, and manages imports, backups, and integrations.
Potential security concerns include unauthorized file access or writes, path traversal, unintended command execution, exposure of secrets, unsafe remote content handling, and data crossing workspace boundaries.
Ordinary bugs and feature requests belong in the [issue forms](https://github.com/doominkim/illithid/issues/new/choose).

## Handling reports

The maintainer will assess the report, request additional information when needed, and coordinate a fix and disclosure where applicable.
Please allow time to investigate and coordinate before publishing details.
This is a maintainer-run project without a guaranteed response or resolution deadline.
