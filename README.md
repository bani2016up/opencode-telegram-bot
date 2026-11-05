# OpenCode Telegram Bot

Control a private [OpenCode](https://opencode.ai/) agent from Telegram without exposing the OpenCode server or a shell to the internet.

The bot provides Telegram-native authorization, Rich Message streaming, workspace switching, slash-command skill invocation, permission approval, and button-based OpenCode controls. It is intended for one owner or a small set of mutually trusted users on a dedicated agent machine.

> [!WARNING]
> An approved Telegram account can ask OpenCode to execute commands and modify files available to the agent account. Treat approval as remote access to that account. Telegram bot chats are not end-to-end encrypted.

## Features

- Access requests approved by configured administrators in private Telegram DMs
- Administrator button for reviewing and revoking approved users
- Authorization by immutable numeric Telegram user ID, never username
- Durable SQLite authorization, session selection, and one-time callback actions
- Native Telegram Rich Message Draft streaming with a Stop button
- Streamed OpenCode reasoning and concise tool activity
- Rich final responses with headings, tables, lists, task lists, code, quotes, footnotes, and formulas
- Sanitization of model-generated Telegram buttons, media, HTML, and unsafe links
- OpenCode session, model, agent, status, workspace, and abort controls through buttons
- OpenCode skills exposed as Telegram-compatible slash commands
- Safe workspace resolution without interpolating paths into shell commands
- Missing-path diagnostics that list the deepest existing directory
- Private chats only, one active operation per user, and prompt length limits

## Architecture

```text
Telegram Bot API
       |
       v
Telegram controller
  - administrator allowlist
  - SQLite authorization
  - opaque callback actions
  - Rich Message renderer
       |
       v
OpenCode SDK over HTTP Basic Auth
       |
       v
OpenCode server on 127.0.0.1
       |
       v
Dedicated agent account and workspaces
```

The bot uses the OpenCode HTTP API and official TypeScript SDK. It does not expose a terminal, PTY, webhook, or OpenCode port publicly.

## Requirements

- Node.js 22 or newer
- OpenCode installed and configured with at least one model provider
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- The numeric Telegram user ID of every administrator
- Telegram clients with Rich Message support for the full streaming experience

## Installation

```bash
git clone https://github.com/bani2016up/opencode-telegram-bot.git
cd opencode-telegram-bot
npm ci
cp .env.example .env
```

Edit `.env` with local values. `.env`, SQLite files, logs, build output, and editor settings are ignored by Git.

Generate independent random secrets rather than reusing the Telegram token:

```bash
openssl rand -base64 32
```

Start OpenCode on loopback with HTTP Basic Auth:

```bash
OPENCODE_SERVER_USERNAME=opencode \
OPENCODE_SERVER_PASSWORD='your-random-password' \
opencode serve --hostname 127.0.0.1 --port 4096
```

Use the same OpenCode URL, username, and password in `.env`, then start the bot:

```bash
npm run dev
```

For a built process:

```bash
npm run build
npm start
```

## Configuration

| Variable                     | Purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`         | Secret token issued by BotFather                            |
| `TELEGRAM_ADMIN_USER_IDS`    | Comma-separated numeric IDs allowed to approve requests     |
| `TELEGRAM_ADMIN_USERNAMES`   | Optional labels for operators; never used for authorization |
| `OPENCODE_BASE_URL`          | Loopback OpenCode URL; non-loopback URLs are rejected       |
| `OPENCODE_SERVER_USERNAME`   | OpenCode Basic Auth username                                |
| `OPENCODE_SERVER_PASSWORD`   | OpenCode Basic Auth password, at least 16 characters        |
| `DATABASE_PATH`              | Local SQLite state file                                     |
| `DEFAULT_WORKDIR`            | Initial workspace for new users                             |
| `AGENT_HOME`                 | Home used to expand `~` and discover global skills          |
| `ALLOWED_WORKSPACE_ROOTS`    | Comma-separated roots users may select                      |
| `ACCESS_REQUEST_TTL_SECONDS` | Lifetime of an administrator approval request               |
| `CALLBACK_TTL_SECONDS`       | Lifetime of an opaque button action                         |
| `MAX_PROMPT_LENGTH`          | Maximum accepted Telegram prompt length                     |
| `STREAM_INTERVAL_MS`         | Minimum interval between draft updates                      |
| `LOG_LEVEL`                  | `debug`, `info`, `warn`, or `error`                         |

Administrators must open the bot and send `/start` once before Telegram allows the bot to deliver access-request DMs. Administrators are pre-authorized by configuration.

## Usage

1. An unknown user sends `/start` in a private chat.
2. Every configured administrator receives an expiring Approve/Deny request.
3. An administrator approves the immutable numeric user ID.
4. The user sends `/start` again to open the control menu.
5. Ordinary text is sent to the selected OpenCode session.
6. `/skill_name optional request` explicitly asks OpenCode to load that skill.

OpenCode skill names may contain hyphens, while Telegram commands may not. The bot maps hyphens to underscores, truncates commands longer than 32 characters with a stable hash, and handles collisions. The command menu is refreshed whenever the workspace changes. Use the Skills button to see all discovered skills; Telegram displays at most 100 registered commands.

To switch directories, press **Workspace** and send an absolute path or a path beginning with `~/`. Paths are canonicalized and restricted to `ALLOWED_WORKSPACE_ROOTS`. If a path does not exist, the bot lists the deepest existing parent without invoking a shell.

## Streaming

The bot immediately creates an ephemeral `sendRichMessageDraft` preview. OpenCode `reasoning` and tool events update the same draft at a throttled interval. Telegram's native Stop button aborts the active OpenCode session.

When OpenCode becomes idle, the bot sanitizes the final Markdown and sends a persistent `sendRichMessage`. The draft disappears automatically. Additional chunks are silent to avoid notification spam. User notification settings still determine whether Telegram produces an audible notification.

Model output cannot create trusted callback buttons. HTML, embedded media, Telegram control links, and unsafe URL schemes are removed before sending. Authorization and permission controls are generated separately and refer to expiring, one-use records in SQLite.

## OpenCode Permissions

Permission behavior remains controlled by OpenCode. To forward sensitive actions to Telegram, configure OpenCode permissions as `ask`. For example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "*": "ask",
    "read": "allow",
    "glob": "allow",
    "grep": "allow"
  }
}
```

The bot exposes **Allow once**, **Allow always**, and **Deny**. **Allow always**
approves future requests matching OpenCode's suggested patterns for the current
OpenCode session. When available, these patterns are shown in the permission
message. After a successful approval, the bot deletes the permission message;
denials remain visible. Buttons are bound to the requesting user and can be used
only once.

## Production Isolation

Run the controller and OpenCode under separate operating-system accounts:

```text
tg-opencode-controller
  owns the Telegram token, .env, SQLite database, and controller process

opencode-agent
  owns workspaces and runs OpenCode
  cannot read controller files
  has no sudo access
```

Keep OpenCode bound to `127.0.0.1`. Do not publish port 4096 through a firewall, reverse proxy, tunnel, container port, or cloud security group. Restrict the controller `.env` and database directory to mode `0600` and `0700` respectively.

Provider credentials remain available to the OpenCode worker by necessity. Repository content, web pages, package scripts, and tool output can contain prompt injection. Use an isolated agent machine, narrow workspace roots, OpenCode permission rules, egress controls, backups, and model-provider spending limits.

See [SECURITY.md](SECURITY.md) for the threat model and vulnerability reporting policy.

## Development

```bash
npm run format
npm run check
npm test
npm run build
```

Tests cover authorization persistence, callback replay protection, workspace containment and symlink escape prevention, Rich Markdown sanitization, configuration validation, and skill discovery.

## Current Scope

- Private Telegram chats only
- Long polling only; no inbound public HTTP endpoint
- One active OpenCode operation per approved user
- Text prompts and responses only
- No provider credential entry through Telegram
- No generic shell or PTY endpoint
- No protection against compromise of the approved Telegram account
- No multi-tenant filesystem isolation between mutually untrusted approved users

## License

[MIT](LICENSE)
