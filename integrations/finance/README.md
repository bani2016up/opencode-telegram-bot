# PRFNV finance integration

The OpenCode agent records personal financial operations in one private Google spreadsheet. Google Sheets remains authoritative. Local SQLite stores delivery receipts and a durable outbox, not a second financial master.

## Components

- `finance.py`: stdio MCP tools, Sheets adapter, validation, XLSX import/export, and retry worker.
- `schema.json`: initial column contract, categories, and currencies.
- `config.example.json`: deployment configuration without credentials.
- `skill/SKILL.md`: the server agent's financial workflow.
- `template.xlsx`: empty workbook with a dashboard, transactions, categories, and charts.

Python 3.11+ is required. Install `requirements.txt` in a dedicated virtual environment. Set `FINANCE_CONFIG` to the private configuration path. Run `python finance.py stdio` for MCP and `python finance.py worker` as a background service. CLI `info`, `report --month YYYY-MM`, `sync`, and `snapshot` support diagnostics without invoking a model.

The deployment must mount a dedicated Google service-account JSON read-only outside `/workspace`. Enable Sheets API in its Cloud project. Grant no Cloud IAM roles. Share only the finance spreadsheet with its email as Editor. The runtime requests only the Sheets scope and is configured with one fixed spreadsheet ID. Do not share other documents with this identity.

## Data contract

Transactions columns A:L are defined in `schema.json`. Dates are real spreadsheet date values. Amounts are positive decimals with at most two fractional digits. Type determines Expense, Income, or Transfer. Transfers require different source and destination accounts in the same currency. Reports separate currencies and exclude transfers from income and spending. Net cash flow is not a balance.

Owner edits to A:H are read on every report. Preserve columns I:L and developer metadata. Categories and currency codes are read from the Categories sheet before writes. The initial capacity is 4,999 transactions plus the header. Extending it requires updating dashboard ranges, table range, and `max_rows` together. No financial examples belong in the production workbook.

## Retry and duplicate handling

A stable Telegram chat/message reference plus item index identifies an operation. A source cannot be reused with different data in the local journal. The atomic Google batch creates a unique metadata ID and appends the row together. A lost response is reconciled against this marker and the full receipt hash in column L. A duplicate batch fails atomically, including its append. Metadata consumes one character per operation; 5,000 configured rows fit the documented 30,000-character spreadsheet budget.

Metadata ID hash collisions fail closed. Removed or conflicting remote receipts require review and are never silently recreated. Manual row edits are preserved. Do not delete metadata to force a retry. A lost local outbox can reconcile existing remote receipts, but unsent operations require restoration from the latest data backup.

Transient network failures and HTTP 408/429/5xx remain queued with exponential retry from 60 seconds to one hour. The worker retries while the agent is idle. Structural, permission, category, and receipt failures stop as `needs_review`. Inspect the cause before any recovery. Only `synced` confirms a Google write. Import enqueues a complete validated file atomically, then uploads operations individually; it is not a multi-row atomic Google transaction.

## Files and backups

XLSX export contains current ledger values and categories. It is a portable snapshot, not a copy of the live dashboard. Import requires the exported A:H column layout, rejects formulas, bounds archive size, and previews before confirmation. Unchanged files receive stable IDs. Editing a file without original Source values changes its import identity; inspect for duplicates before importing modified copies.

The worker writes a daily JSON ledger snapshot in `state_directory/snapshots`. These snapshots stay on the same server and are not disaster recovery by themselves. Back up the state directory, Google service-account credential, configuration, and complete Google workbook independently. The infrastructure repository records their locations, with credentials encrypted outside Git.

## Validation

Run `python -m unittest discover -s tests -v`. Use a disposable spreadsheet for integration tests. Verify duplicate retries, ambiguous responses, queue restart, manual edits, currency isolation, transfers, XLSX preview, and blank production state. Do not test by sending financial messages to the production Telegram bot.

References: [Google atomic batches](https://developers.google.com/workspace/sheets/api/limits), [developer metadata](https://developers.google.com/workspace/sheets/api/guides/metadata), [service-account authentication](https://developers.google.com/identity/protocols/oauth2/service-account).
