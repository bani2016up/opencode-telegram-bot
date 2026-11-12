import copy
import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from finance import EPOCH, HEADERS, SCHEMA, FinanceError, GoogleSheets, Ledger, TemporaryFailure, fingerprint, load_config, normalize_operation


def operation(**changes):
    value = dict(source_id="telegram:123:456:1", date="2026-11-07", type="Expense", amount="125.50",
                 currency="RUB", category="Groceries", account="Card", to_account="", note="Lunch")
    return {**value, **changes}


class FakeSheets(GoogleSheets):
    def __init__(self, config):
        self.config = config
        self.data = [HEADERS.copy()]
        self.markers = {}
        self.offline = False
        self.lose_response = False
        self.last_batch = None

    def metadata(self, identifier):
        if self.offline:
            raise TemporaryFailure("Offline")
        return self.markers.get(identifier)

    def catalog(self):
        return {"categories": copy.deepcopy(SCHEMA["categories"]), "currencies": SCHEMA["currencies"]}

    def values(self, sheet, address):
        if self.offline:
            raise TemporaryFailure("Offline")
        return copy.deepcopy(self.data)

    def request(self, method, suffix="", **kwargs):
        if method == "GET":
            return {"sheets": [{"properties": {"sheetId": 1, "title": "Transactions"}}]}
        batch = kwargs["json"]["requests"]
        self.last_batch = batch
        marker = batch[0]["createDeveloperMetadata"]["developerMetadata"]
        if marker["metadataId"] in self.markers:
            raise FinanceError("Duplicate metadata ID")
        cells = batch[1]["appendCells"]["rows"][0]["values"]
        self.markers[marker["metadataId"]] = marker
        self.data.append([next(iter(cell["userEnteredValue"].values())) for cell in cells])
        if self.lose_response:
            self.lose_response = False
            raise TemporaryFailure("Response lost after commit")
        return {}


class FinanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = {"state_directory": self.temp.name + "/state", "files_directory": self.temp.name + "/files",
                       "spreadsheet_id": "a"*40, "default_currency": "RUB", "timezone": "Europe/Moscow",
                       "transactions_sheet": "Transactions", "categories_sheet": "Categories", "max_rows": 5000,
                       "retry_seconds": 60}
        self.backend = FakeSheets(self.config)
        self.ledger = Ledger(self.config, self.backend)

    def test_configured_currency_and_timezone_are_used(self):
        config = {**self.config, "default_currency": "USD", "timezone": "UTC"}
        ledger = Ledger(config, self.backend)
        info = ledger.info()
        self.assertEqual(info["default_currency"], "USD")
        self.assertEqual(info["timezone"], "UTC")
        self.assertEqual(info["today"], dt.datetime.now(dt.timezone.utc).date().isoformat())
        values = operation()
        del values["currency"]
        self.assertEqual(ledger.record(**values)["status"], "synced")
        self.assertEqual(self.backend.data[1][3], "USD")
        self.assertEqual(ledger.report("2026-11")["expenses"], "125.50")
        self.assertEqual(ledger.report("2026-11", "RUB")["expenses"], "0.00")

    def test_repeated_source_is_one_row_across_process_restart(self):
        self.assertEqual(self.ledger.record(**operation())["status"], "synced")
        other = Ledger(self.config, self.backend)
        self.assertEqual(other.record(**operation())["status"], "synced")
        self.assertEqual(len(self.backend.data), 2)

    def test_same_source_with_different_payload_is_rejected(self):
        self.ledger.record(**operation())
        with self.assertRaisesRegex(FinanceError, "different operation"):
            self.ledger.record(**operation(amount="130"))
        self.assertEqual(len(self.backend.data), 2)

    def test_lost_response_reconciles_without_duplicate(self):
        self.backend.lose_response = True
        self.assertEqual(self.ledger.record(**operation())["status"], "synced")
        self.assertEqual(len(self.backend.data), 2)

    def test_remote_receipt_prevents_duplicate_after_local_state_loss(self):
        self.ledger.record(**operation())
        new_config = {**self.config, "state_directory": self.temp.name + "/restored"}
        other = Ledger(new_config, self.backend)
        self.assertEqual(other.record(**operation())["status"], "synced")
        self.assertEqual(len(self.backend.data), 2)

    def test_deleted_remote_row_is_not_recreated(self):
        self.ledger.record(**operation())
        self.backend.data = [HEADERS.copy()]
        other = Ledger({**self.config, "state_directory": self.temp.name + "/restored"}, self.backend)
        self.assertEqual(other.record(**operation())["status"], "needs_review")
        self.assertEqual(len(self.backend.data), 1)

    def test_offline_queue_survives_restart_and_backoff(self):
        self.backend.offline = True
        result = self.ledger.record(**operation())
        self.assertEqual(result["status"], "pending")
        self.backend.offline = False
        other = Ledger(self.config, self.backend)
        self.assertEqual(len(other.sync()["queue"]), 1)
        with patch("finance.time.time", return_value=9999999999):
            self.assertEqual(other.sync()["queue"], [])
        self.assertEqual(len(self.backend.data), 2)

    def test_formula_like_note_is_literal(self):
        self.ledger.record(**operation(note="=IMPORTXML(\"https://example.invalid\",\"//x\")"))
        cell = self.backend.last_batch[1]["appendCells"]["rows"][0]["values"][7]
        self.assertIn("stringValue", cell["userEnteredValue"])

    def test_unknown_category_and_header_changes_do_not_write(self):
        self.assertEqual(self.ledger.record(**operation(category="Unknown"))["status"], "needs_review")
        self.backend.data[0][0] = "Changed"
        self.assertEqual(self.ledger.record(**operation(source_id="another"))["status"], "needs_review")
        self.assertEqual(len(self.backend.data), 1)

    def test_validation_rejects_invalid_amounts_dates_and_transfers(self):
        for change in [dict(amount="NaN"),dict(amount="-1"),dict(amount="0"),dict(amount="1.001"),
                       dict(amount=True),dict(date="2026-02-30"),dict(type="Refund"),dict(type="Transfer"),
                       dict(type="Transfer",to_account="Card"),dict(source_id="bad id"),dict(account="")]:
            with self.subTest(change=change), self.assertRaises(FinanceError):
                normalize_operation(operation(**change), "RUB")

    def test_report_reads_manual_edits_excludes_transfers_and_other_currencies(self):
        self.ledger.record(**operation())
        self.backend.data[1][2] = 100  # Owner edited the source of truth.
        self.ledger.record(**operation(source_id="income", type="Income", category="Salary", amount="1000"))
        self.ledger.record(**operation(source_id="usd", currency="USD", amount="50"))
        self.ledger.record(**operation(source_id="transfer", type="Transfer", category="Internal transfer", amount="500", to_account="Cash"))
        self.ledger.record(**operation(source_id="old", date="2026-10-01", amount="250"))
        report = self.ledger.report("2026-11", "RUB")
        self.assertEqual((report["income"], report["expenses"], report["net_cash_flow"]), ("1000.00","100.00","900.00"))
        self.assertEqual(report["transaction_count"], 3)
        self.assertEqual(self.ledger.report("2026-11", "USD")["expenses"], "50.00")

    def test_cancel_refuses_remote_receipt(self):
        result = self.ledger.record(**operation())
        with self.ledger.connect() as db:
            db.execute("UPDATE operations SET status='pending'")
        with self.assertRaisesRegex(FinanceError, "already recorded"):
            self.ledger.cancel_pending(result["id"])

    def test_marker_collision_fails_closed(self):
        with patch.object(self.backend, "metadata", return_value={"metadataKey": "f"}):
            self.assertEqual(self.ledger.record(**operation())["status"], "needs_review")
        self.assertEqual(len(self.backend.data), 1)

    def test_xlsx_export_import_keeps_source_id_and_literal_notes(self):
        self.ledger.record(**operation(note="=1+1"))
        result = self.ledger.export_xlsx()
        preview = self.ledger.import_preview(result["file"])
        self.assertEqual(preview["row_count"], 1)
        self.assertEqual(preview["operations"][0]["note"], "=1+1")
        self.ledger.import_confirm(result["file"], preview["sha256"])
        self.assertEqual(len(self.backend.data), 2)
        with self.assertRaisesRegex(FinanceError, "changed after preview"):
            self.ledger.import_confirm(result["file"], "wrong")

    def test_xlsx_import_rejects_formulas_and_outside_paths(self):
        from openpyxl import Workbook
        book = Workbook()
        sheet = book.active
        sheet.title = "Transactions"
        sheet.append(HEADERS)
        sheet.append(["2026-11-07", "Expense", "=2+2", "RUB", "Groceries", "Card"])
        path = self.ledger.file_path("unsafe.xlsx")
        book.save(path)
        with self.assertRaisesRegex(FinanceError, "contains formulas"):
            self.ledger.import_preview("unsafe.xlsx")
        with self.assertRaises(FinanceError):
            self.ledger.file_path("../outside.xlsx")

    def test_xlsx_import_queues_atomically_and_repeat_is_idempotent(self):
        from openpyxl import Workbook
        book = Workbook()
        sheet = book.active
        sheet.title = "Transactions"
        sheet.append(HEADERS)
        sheet.append(["2026-11-07","Expense",100,"RUB","Groceries","Card"])
        sheet.append(["2026-11-07","Income",1000,"RUB","Salary","Card"])
        path = self.ledger.file_path("import.xlsx")
        book.save(path)
        preview = self.ledger.import_preview("import.xlsx")
        self.ledger.import_confirm("import.xlsx",preview["sha256"])
        self.ledger.import_confirm("import.xlsx",preview["sha256"])
        self.assertEqual(len(self.backend.data),3)


class ConfigTests(unittest.TestCase):
    def test_config_location_must_be_explicit(self):
        for value in (None, "", "relative/config.json"):
            env = {} if value is None else {"FINANCE_CONFIG": value}
            with self.subTest(value=value), patch.dict(os.environ, env, clear=True):
                with self.assertRaisesRegex(FinanceError, "FINANCE_CONFIG"):
                    load_config()

    def test_custom_config_preserves_existing_state_and_preferences(self):
        with tempfile.TemporaryDirectory(prefix="finance config ") as directory:
            config = json.loads(Path(__file__).parents[1].joinpath("config.example.json").read_text())
            config.update(spreadsheet_id="a" * 40, state_directory=directory + "/existing-state",
                          credentials_file=directory + "/service.json", files_directory=directory + "/files",
                          default_currency="EUR", timezone="Europe/Paris")
            path = Path(directory) / "custom.json"
            path.write_text(json.dumps(config))
            with patch.dict(os.environ, {"FINANCE_CONFIG": str(path)}):
                self.assertEqual(load_config(), config)

    def test_unreadable_or_invalid_json_has_actionable_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            with patch.dict(os.environ, {"FINANCE_CONFIG": str(path)}):
                with self.assertRaisesRegex(FinanceError, "Cannot read FINANCE_CONFIG"):
                    load_config()
                path.write_text("{not valid json")
                with self.assertRaisesRegex(FinanceError, "Cannot read FINANCE_CONFIG"):
                    load_config()


if __name__ == "__main__":
    unittest.main()
