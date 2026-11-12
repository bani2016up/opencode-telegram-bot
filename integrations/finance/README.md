# Google Sheets finance integration

An optional, standalone example for personal finance tracking. It has no dependency on a
particular owner, website, or deployment. The Telegram bot runs normally without it. See the
[integration guide](../README.md) to add other services or keep your own modules private.

The OpenCode agent records personal financial operations in one private Google spreadsheet. Google Sheets remains authoritative. Local SQLite stores delivery receipts and a durable outbox, not a second financial master.

## Components

- `finance.py`: stdio MCP tools, Sheets adapter, validation, XLSX import/export, and retry worker.
- `schema.json`: initial column contract, categories, and currencies.
- `config.example.json`: deployment configuration without credentials.
- `opencode.example.json`: MCP configuration for the OpenCode 1.x configuration format used by this project's SDK.
- `skill/SKILL.md`: the server agent's financial workflow.
- `template.xlsx`: empty workbook with a dashboard, transactions, categories, and charts.

## Setup

Use Python 3.11+ on Linux or macOS (the journal uses POSIX file locking). Run these commands
from the repository root on the OpenCode worker:

```bash
python3 -m venv integrations/finance/.venv
integrations/finance/.venv/bin/python -m pip install -r integrations/finance/requirements.lock
cp integrations/finance/config.example.json integrations/finance/config.json
export FINANCE_CONFIG="$(pwd)/integrations/finance/config.json"
```

`requirements.lock` pins the deployment environment; `requirements.txt` lists direct dependencies
for maintaining it. Neither is needed to install or run the Telegram controller.

1. Upload `template.xlsx` to Google Drive and convert it to a native Google spreadsheet.
2. Create a dedicated Google service account and enable the Sheets API in its Cloud project.
   Share only this spreadsheet with the service-account email as Editor.
3. Edit your private config: set the spreadsheet ID, credential path, state and import/export
   directories, default currency, and IANA timezone. All file and directory paths must be absolute
   and visible to the worker. `USD` and `UTC` are example preferences; change them as needed.
4. Review the Categories sheet's category/type pairs and currency codes. Set Dashboard's month
   and currency to the values you want to display. Keep the configured worksheet names in sync
   with the workbook and its formulas. `schema.json` describes the initial template; changing it
   does not update an existing spreadsheet.
5. Run a read-only connection check:

```bash
integrations/finance/.venv/bin/python integrations/finance/finance.py info
```

`FINANCE_CONFIG` is required. There is no machine-specific default configuration location.
The local `config.json` and `.venv` are ignored by Git. Keep credentials and financial data
outside the repository.

### Enable in OpenCode

Merge the `mcp` entry from [opencode.example.json](opencode.example.json) into the worker's
configuration. Replace every placeholder path. This example uses the OpenCode 1.x format
represented by the bot's SDK: servers live directly under `mcp` and use `enabled`.
For OpenCode V2, put the entry under `mcp.servers` and replace `enabled: true` with
`disabled: false`; see the [MCP configuration reference](https://opencode.ai/docs/mcp-servers/).
The example only registers finance; preserve your existing providers, permissions, and servers.

Copy `skill/SKILL.md` to `.opencode/skills/finance/SKILL.md` in the target workspace, or
`~/.config/opencode/skills/finance/SKILL.md` for all workspaces. Make the installed skill readable
by the controller as described in the [integration guide](../README.md#connect-an-integration).
Reload OpenCode and reselect the Telegram workspace. The workflow is available as `/finance`.

### Background retries

OpenCode starts `finance.py stdio` for MCP tools. Run a separate worker with the **same**
`FINANCE_CONFIG` so pending operations retry even when the agent is idle:

```bash
integrations/finance/.venv/bin/python integrations/finance/finance.py worker
```

Use your process supervisor to keep it running. For a container that runs the OpenCode worker,
`entrypoint.sh` can supervise both processes (Bash 4.3+ required). It finds `finance.py` beside
it and uses the adjacent `.venv/bin/python`, or the executable specified by `FINANCE_PYTHON`:

```bash
bash integrations/finance/entrypoint.sh serve --hostname 127.0.0.1 --port 4096
```

Set `FINANCE_CONFIG` in the supervisor/container environment as well as the MCP configuration.
Keep the existing OpenCode authentication environment. CLI `info`, `report --month YYYY-MM`,
`sync`, and `snapshot` support diagnostics without invoking a model.

To disable finance, remove the MCP entry and installed skill, and stop the retry worker.
If using `entrypoint.sh`, switch back to starting OpenCode directly. Retain the state directory
and spreadsheet if you may enable it again.

### Updating an existing installation

Set `FINANCE_CONFIG` explicitly to your existing configuration file in both the MCP entry and
worker environment. Keep its spreadsheet ID, credential path, state directory, currency, and
timezone unchanged to retain the journal and queued operations. If you keep an existing virtual
environment outside `.venv`, point both the MCP command and `FINANCE_PYTHON` at its Python.
Replace the installed skill with the `finance` skill and remove any older copy to avoid duplicate
slash commands. No ledger or receipt migration is required.

### Credentials

Keep the dedicated Google service-account JSON outside the agent's project workspaces and mount
it read-only in container deployments. Grant no Cloud IAM roles. The runtime requests only the
Sheets scope and is configured with one fixed spreadsheet ID. Do not share other documents with
this identity.

## Data contract

Transactions columns A:L are defined in `schema.json`. Dates are real spreadsheet date values. Amounts are positive decimals with at most two fractional digits. Type determines Expense, Income, or Transfer. Transfers require different source and destination accounts in the same currency. Reports separate currencies and exclude transfers from income and spending. Net cash flow is not a balance.

Owner edits to A:H are read on every report. Preserve columns I:L and developer metadata. Categories and currency codes are read from the Categories sheet before writes. The initial capacity is 4,999 transactions plus the header. Extending it requires updating dashboard ranges, table range, and `max_rows` together. No financial examples belong in the production workbook.

## Retry and duplicate handling

A stable Telegram chat/message reference plus item index identifies an operation. A source cannot be reused with different data in the local journal. The atomic Google batch creates a unique metadata ID and appends the row together. A lost response is reconciled against this marker and the full receipt hash in column L. A duplicate batch fails atomically, including its append. Metadata consumes one character per operation; 5,000 configured rows fit the documented 30,000-character spreadsheet budget.

Metadata ID hash collisions fail closed. Removed or conflicting remote receipts require review and are never silently recreated. Manual row edits are preserved. Do not delete metadata to force a retry. A lost local outbox can reconcile existing remote receipts, but unsent operations require restoration from the latest data backup.

Transient network failures and HTTP 408/429/5xx remain queued with exponential retry from 60 seconds to one hour. The worker retries while the agent is idle. Structural, permission, category, and receipt failures stop as `needs_review`. Inspect the cause before any recovery. Only `synced` confirms a Google write. Import enqueues a complete validated file atomically, then uploads operations individually; it is not a multi-row atomic Google transaction.

## Files and backups

XLSX export contains current ledger values and categories. It is a portable snapshot, not a copy of the live dashboard. Import requires the exported A:H column layout, rejects formulas, bounds archive size, and previews before confirmation. Unchanged files receive stable IDs. Editing a file without original Source values changes its import identity; inspect for duplicates before importing modified copies.

The worker writes a daily JSON ledger snapshot in `state_directory/snapshots`. These snapshots stay on the same server and are not disaster recovery by themselves. Back up the state directory, Google service-account credential, configuration, and complete Google workbook independently. Document their locations in your own deployment notes and keep credentials encrypted outside Git.

## Validation

From the repository root, run `integrations/finance/.venv/bin/python -m unittest discover -s integrations/finance/tests -v`. Unit tests use a fake Sheets service and do not require credentials. Use a disposable spreadsheet for live integration tests. Verify duplicate retries, ambiguous responses, queue restart, manual edits, currency isolation, transfers, XLSX preview, and blank production state. Do not test by sending financial messages to the production Telegram bot.

References: [Google atomic batches](https://developers.google.com/workspace/sheets/api/limits), [developer metadata](https://developers.google.com/workspace/sheets/api/guides/metadata), [service-account authentication](https://developers.google.com/identity/protocols/oauth2/service-account).
