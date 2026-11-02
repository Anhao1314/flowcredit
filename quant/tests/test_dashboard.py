import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from dashboard.server import (
    DEFAULT_CONFIG,
    RunError,
    build_command,
    latest_payload,
    load_config,
    make_server,
    scan_runs,
)


def write_json(path: Path, payload):
    path.write_text(json.dumps(payload), encoding="utf-8")


class DashboardUnitTests(unittest.TestCase):
    def test_load_config_merges_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            write_json(path, {"csv": "x.csv", "top_n": 3})
            config = load_config(path)
            self.assertEqual(config["csv"], "x.csv")
            self.assertEqual(config["top_n"], 3)
            self.assertEqual(config["train_days"], DEFAULT_CONFIG["train_days"])

    def test_build_command_is_allowlisted(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "prices.csv"
            csv_path.write_text("date,symbol,open,high,low,close,volume\n", encoding="utf-8")
            actions_path = Path(tmp) / "actions.csv"
            actions_path.write_text(
                "date,symbol,kind,cash_per_share,share_ratio\n", encoding="utf-8"
            )
            config = dict(DEFAULT_CONFIG)
            config.update(
                {
                    "csv": str(csv_path),
                    "actions": str(actions_path),
                    "oos_csv": str(csv_path),
                    "oos_actions": str(actions_path),
                    "data_source": "test",
                }
            )
            command = build_command("backtest", config, Path(tmp) / "out")
            self.assertIn("run.py", command[1])
            self.assertIn("backtest", command)
            self.assertIn("--csv", command)
            self.assertIn(str(csv_path), command)
            self.assertIn("--actions", command)
            self.assertIn("--data-source", command)
            self.assertNotIn("shell", command)

            oos_command = build_command("oos", config, Path(tmp) / "out")
            self.assertIn("oos", oos_command)
            self.assertIn("--start", oos_command)
            self.assertIn("--end", oos_command)
            self.assertIn("--primary-lookback", oos_command)

    def test_build_command_rejects_unknown_kind(self):
        with self.assertRaises(RunError):
            build_command("rm -rf", DEFAULT_CONFIG, Path("/tmp"))

    def test_build_command_rejects_missing_csv(self):
        config = dict(DEFAULT_CONFIG)
        config["csv"] = "/tmp/definitely-not-here-flowcredit.csv"
        with self.assertRaises(RunError):
            build_command("backtest", config, Path("/tmp"))

    def test_latest_payload_and_scan_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            write_json(
                out / "latest.json",
                {
                    "run_id": "bt-test",
                    "status": "BACKTEST_ONLY",
                    "metrics": {"total_return": 0.1, "sharpe": 1.2},
                    "equity_curve": [{"date": "2024-01-02", "equity": 100000}],
                    "risk_events": [],
                    "evidence_status": {"live_trading": "NOT_RUN"},
                },
            )
            write_json(
                out / "latest-walkforward.json",
                {
                    "run_id": "wf-test",
                    "status": "WALK_FORWARD_BACKTEST",
                    "windows": [],
                    "oos_metrics": {"sharpe": 1.0},
                    "selection_bias": {"bonferroni_p_value": 1.0},
                },
            )
            write_json(
                out / "latest-robustness.json",
                {
                    "run_id": "rb-test",
                    "status": "ROBUSTNESS_SUITE",
                    "scenarios": [{"name": "base", "status": "OK"}],
                    "verdict": {"selection_stability": "UNSTABLE"},
                    "regimes": [],
                },
            )
            write_json(
                out / "latest-oos.json",
                {
                    "run_id": "oos-test",
                    "status": "FROZEN_OOS_BACKTEST",
                    "selection": "FROZEN",
                    "primary_lookback": 40,
                    "primary": {"metrics": {"total_return": 0.1, "sharpe": 0.5}},
                },
            )
            write_json(
                out / "frozen-oos-oos-test.json",
                {
                    "run_id": "oos-test",
                    "status": "FROZEN_OOS_BACKTEST",
                    "primary_lookback": 40,
                    "primary": {"metrics": {"total_return": 0.1, "sharpe": 0.5}},
                },
            )
            write_json(
                out / "baostock-test.manifest.json",
                {"source": "baostock", "row_count": 10, "data_hash": "abc"},
            )
            write_json(
                out / "backtest-bt-test.json",
                {
                    "run_id": "bt-test",
                    "status": "BACKTEST_ONLY",
                    "metrics": {"total_return": 0.1, "sharpe": 1.2},
                },
            )

            payload = latest_payload(out)
            self.assertEqual(payload["backtest"]["run_id"], "bt-test")
            self.assertEqual(payload["walkforward"]["run_id"], "wf-test")
            self.assertEqual(payload["robustness"]["run_id"], "rb-test")
            self.assertEqual(payload["oos"]["run_id"], "oos-test")
            self.assertEqual(payload["manifest"]["source"], "baostock")

            runs = scan_runs(out)
            kinds = {run["kind"] for run in runs}
            self.assertIn("backtest", kinds)
            self.assertIn("oos", kinds)
            self.assertEqual(runs[0]["kind"], "backtest")
            self.assertEqual(runs[0]["run_id"], "bt-test")


class DashboardHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.out = Path(self.temp.name) / "out"
        self.out.mkdir()
        write_json(
            self.out / "latest.json",
            {
                "run_id": "bt-test",
                "status": "BACKTEST_ONLY",
                "metrics": {"total_return": 0.1, "sharpe": 1.2},
                "equity_curve": [
                    {"date": "2024-01-02", "equity": 100000},
                    {"date": "2024-01-03", "equity": 101000},
                ],
                "risk_events": [],
                "evidence_status": {"live_trading": "NOT_RUN"},
            },
        )
        config_path = Path(self.temp.name) / "config.json"
        write_json(config_path, {"csv": "missing.csv"})
        self.server = make_server("127.0.0.1", 0, self.out, config_path)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def test_health(self):
        with urlopen(self.url("/api/health"), timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["status"], "ok")

    def test_latest_and_runs(self):
        with urlopen(self.url("/api/latest"), timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["backtest"]["run_id"], "bt-test")

        with urlopen(self.url("/api/runs"), timeout=5) as response:
            runs = json.loads(response.read().decode("utf-8"))["runs"]
        self.assertIsInstance(runs, list)

    def test_index_served(self):
        with urlopen(self.url("/"), timeout=5) as response:
            body = response.read().decode("utf-8")
        self.assertIn("Research Dashboard", body)

    def test_rejects_unknown_run_kind(self):
        request = Request(
            self.url("/api/run"),
            data=json.dumps({"kind": "rm -rf"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(HTTPError) as context:
            urlopen(request, timeout=5)
        self.assertEqual(context.exception.code, 400)


if __name__ == "__main__":
    unittest.main()