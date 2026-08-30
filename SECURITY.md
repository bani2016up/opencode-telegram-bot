# Security Policy

## Supported Versions

Security fixes are applied to the latest release on the default branch.

## Reporting a Vulnerability

Do not open a public issue containing an exploitable vulnerability, bot token, provider credential, Telegram user ID, private path, prompt content, or server address.

Use GitHub's private vulnerability reporting feature for this repository. Include the affected version, impact, reproduction steps, and any suggested mitigation. Remove all real credentials and personal information from the report.

## Security Model

The Telegram bot token and configured numeric administrator IDs are roots of trust. Approval grants the user the ability to direct OpenCode with the operating-system permissions of the OpenCode worker.

The project assumes:

- Telegram delivers authentic numeric sender IDs to the Bot API.
- The controller token, environment, database, and process are inaccessible to the OpenCode worker.
- OpenCode listens only on loopback and uses a strong independent password.
- Approved users are trusted with access to the configured workspace roots.
- The agent machine is disposable or backed up and contains no unrelated secrets.

The project does not claim to protect against:

- Compromise of an approved Telegram account or active Telegram session
- Compromise of the Telegram Bot API or model provider
- Malicious behavior by an explicitly approved OpenCode operation
- Secrets available to the OpenCode worker itself
- Root compromise of the host
- Multiple mutually untrusted users sharing the same worker account

## Deployment Checklist

- Use numeric Telegram IDs for administrators; never authorize by username.
- Enable Telegram two-step verification for every administrator and approved user.
- Run the controller and OpenCode under separate operating-system accounts.
- Keep the OpenCode port on loopback and enable `OPENCODE_SERVER_PASSWORD`.
- Restrict `.env`, the SQLite database, and logs to the controller account.
- Configure narrow `ALLOWED_WORKSPACE_ROOTS` values.
- Configure OpenCode permission rules for destructive and external operations.
- Do not store production secrets in workspaces available to the agent.
- Configure provider spending limits and monitor unexpected usage.
- Keep Node.js, OpenCode, and dependencies updated.
- Back up important workspaces before enabling remote modification.
