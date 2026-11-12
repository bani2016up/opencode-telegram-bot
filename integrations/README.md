# Optional integrations

Integrations add domain-specific tools and workflows to the OpenCode worker. The Telegram
controller handles access, sessions, messages, and permissions. It does not need to know which
services you use. No integration in this directory is installed or enabled automatically.

Use an existing MCP server, write a skill around tools you already have, or build a small module
for your own service. You can keep modules in a separate repository or in the Git-ignored
`integrations/local/` directory. Publishing personal integrations with the bot is optional.

## Included example

| Integration                  | What it adds                                                      | Dependencies                                                |
| ---------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| [Finance](finance/README.md) | Google Sheets income, expenses, transfers, and XLSX import/export | Python, a private spreadsheet, and a Google service account |

Finance is a standalone example. You can omit the entire `integrations/` directory from a bot
deployment that does not use it. Its Python packages are separate from the bot's npm dependencies.

## Connect an integration

1. Install the service or module on the **OpenCode worker**, under the agent's operating-system
   account. Use a separate environment for its dependencies. The controller container is not the
   worker and does not need integration credentials.
2. Register its MCP server in the worker's OpenCode configuration, if it supplies tools. Use
   absolute paths visible to the worker; container paths may differ from host paths. Consult the
   [OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers/) for your server version.
3. If it supplies a workflow, copy its `SKILL.md` into
   `.opencode/skills/<name>/SKILL.md` in the selected workspace, or
   `~/.config/opencode/skills/<name>/SKILL.md` for all workspaces. For this bot's discovery, use a
   lowercase hyphenated `name` and a `description` in YAML frontmatter. The controller needs
   read access to that skill directory, with `AGENT_HOME` configured for global skills.
4. Restart or reload OpenCode, then reselect the workspace in Telegram to refresh its skill
   menu. A skill named `my-service` is invoked as `/my_service`. MCP tools alone do not create
   Telegram slash commands.
5. Try a read-only request first. Check the module's configuration and permissions before
   enabling writes. To disable it, remove its MCP entry and installed skill, and stop any
   separate background worker.

Skills describe how to use tools; they do not install packages, configure MCP, or grant access.
Keeping a module here also does not register it. Existing
[OpenCode permission controls](../README.md#opencode-permissions) still apply.

## Build your own

There is no bot-specific plugin API or registry to implement. Use OpenCode's existing MCP and
skill interfaces. Choose any language supported by your worker.

A shareable module should include:

- A README with prerequisites, installation, enable/disable steps, and a read-only smoke check.
- A configuration example with placeholders for paths, accounts, endpoints, and credentials.
- An MCP server or scripts for the service, plus a skill when the workflow benefits from one.
- Its own dependencies and focused tests with fake services or disposable test accounts.
- Explicit success/failure results, and stable request IDs for writes that may be retried.

Keep tokens, private endpoints, personal data, and production configuration outside tracked
files. Give the worker only the service access the module needs. A module using one account is
shared by the trusted users of that worker; it does not add per-Telegram-user account isolation.

You can ask a coding agent to implement the module:

> Add an optional OpenCode integration for [service/task]. Use an existing MCP server if suitable;
> otherwise build a standalone module in integrations/local/[name]. Keep the Telegram controller
> unchanged. Make paths, credentials, endpoints, and user preferences configurable. Include a
> config example, installation and removal steps, a workflow skill if useful, and tests with fake
> services. Define how writes are authorized and retried without duplication. Keep my private
> configuration and data out of Git. Use integrations/finance as an example of the separation
> between tools, workflow, and deployment, without copying its finance-specific behavior.

Reusable modules can be contributed independently. A personal module can stay private indefinitely.
