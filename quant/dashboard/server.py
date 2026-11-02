#!/usr/bin/env python3
"""Local post-run dashboard for FlowCredit Quant.

This is deliberately small and boring: a stdlib HTTP server bound to localhost,
JSON endpoints over the files already written by `run.py`, and a vanilla
frontend. It does not stream live market data and it does not accept arbitrary
commands. The run buttons execute an allowlisted `run.py` subcommand with paths
from `dashboard/config.json`; no shell, no request-supplied paths.
"""

from __future__ import annotations

import argparse
import errno
import json
import mimetypes
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_DIR = Path(__file__).resolve().parent
DEFAULT_OUT = ROOT / "out"
DEFAULT_CONFIG_PATH = DASHBOARD_DIR / "config.json"

DEFAULT_CONFIG: Dict[str, Any] = {
    "csv": "out/baostock-2y-raw.csv",
    "actions": "out/baostock-2y-raw-actions.csv",
    "oos_csv": "out/baostock-hs300-2024-12-31-raw.csv",
    "oos_actions": "out/baostock-hs300-2024-12-31-raw-actions.csv",
    "oos_delist_json": "out/baostock-hs300-2024-12-31-raw-delisted.json",
    "data_source": "baostock",
    "lookback": 20,
    "train_days": 252,
    "test_days": 63,
    "lookbacks": "10,20,40,60",
    "primary_lookback": 40,
    "oos_start": "2025-01-01",
    "oos_end": "2026-10-31",
    "top_n": 2,
    "rebalance_every": 5,
    "max_weight": 0.35,
    "cash": 100000.0,
    "max_drawdown": 0.12,
    "commission_bps": 5.0,
    "slippage_bps": 10.0,
}

RUN_KINDS = ("backtest", "walkforward", "robustness", "oos")


class RunError(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def load_config(path: Optional[Path] = None) -> Dict[str, Any]:
    config = dict(DEFAULT_CONFIG)
    if path is not None and Path(path).exists():
        loaded = _read_json(Path(path))
        if loaded:
            config.update(loaded)
    return config


def _resolve(path_value: str) -> Path:
    path = Path(str(path_value))
    return path if path.is_absolute() else ROOT / path


def build_command(kind: str, config: Dict[str, Any], out_dir: Path) -> List[str]:
    if kind not in RUN_KINDS:
        raise RunError(f"unsupported run kind: {kind!r}")

    csv_value = (
        config.get("oos_csv") if kind == "oos" else config.get("csv", "")
    )
    csv_path = _resolve(str(csv_value))
    if not csv_path.exists():
        raise RunError(f"data CSV does not exist: {csv_path}")

    command = [
        sys.executable,
        str(ROOT / "run.py"),
        kind,
        "--csv",
        str(csv_path),
        "--out",
        str(Path(out_dir)),
        "--cash",
        str(config.get("cash", 100000.0)),
        "--top-n",
        str(config.get("top_n", 2)),
        "--rebalance-every",
        str(config.get("rebalance_every", 5)),
        "--max-weight",
        str(config.get("max_weight", 0.35)),
        "--max-drawdown",
        str(config.get("max_drawdown", 0.12)),
        "--commission-bps",
        str(config.get("commission_bps", 5.0)),
        "--slippage-bps",
        str(config.get("slippage_bps", 10.0)),
        "--data-source",
        str(config.get("data_source", "unknown")),
    ]

    actions_value = str(
        (
            config.get("oos_actions")
            if kind == "oos"
            else config.get("actions", "")
        )
        or ""
    )
    if actions_value:
        actions_path = _resolve(actions_value)
        if actions_path.exists():
            command.extend(["--actions", str(actions_path)])

    if kind == "backtest":
        command.extend(["--lookback", str(config.get("lookback", 20))])
    elif kind == "oos":
        command.extend(
            [
                "--start",
                str(config.get("oos_start", "2025-01-01")),
                "--end",
                str(config.get("oos_end", "2026-10-31")),
                "--lookbacks",
                str(config.get("lookbacks", "10,20,40,60")),
                "--primary-lookback",
                str(config.get("primary_lookback", 40)),
            ]
        )
        delist_value = str(config.get("oos_delist_json", "") or "")
        if delist_value:
            delist_path = _resolve(delist_value)
            if delist_path.exists():
                command.extend(["--delist-json", str(delist_path)])
    else:
        command.extend(
            [
                "--train-days",
                str(config.get("train_days", 252)),
                "--test-days",
                str(config.get("test_days", 63)),
                "--lookbacks",
                str(config.get("lookbacks", "10,20,40,60")),
            ]
        )

    return command


def _tail(path_value: Optional[str], lines: int = 30) -> List[str]:
    if not path_value:
        return []
    path = Path(path_value)
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return content.splitlines()[-lines:]


_RUN_LOCK = threading.Lock()
_RUN_STATE: Dict[str, Any] = {
    "status": "idle",
    "kind": None,
    "started_at": None,
    "finished_at": None,
    "exit_code": None,
    "log_path": None,
}


def get_run_state() -> Dict[str, Any]:
    with _RUN_LOCK:
        state = dict(_RUN_STATE)
    state["log_tail"] = _tail(state.get("log_path"))
    return state


def start_run(kind: str, config: Dict[str, Any], out_dir: Path) -> Dict[str, Any]:
    command = build_command(kind, config, out_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / "dashboard-run.log"

    with _RUN_LOCK:
        if _RUN_STATE["status"] == "running":
            raise RuntimeError("a run is already in progress")
        log_handle = log_path.open("w", encoding="utf-8")
        try:
            process = subprocess.Popen(
                command,
                cwd=str(ROOT),
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                text=True,
            )
        finally:
            log_handle.close()

        _RUN_STATE.update(
            {
                "status": "running",
                "kind": kind,
                "started_at": _now(),
                "finished_at": None,
                "exit_code": None,
                "log_path": str(log_path),
            }
        )
        state = dict(_RUN_STATE)

    def wait_for_exit() -> None:
        exit_code = process.wait()
        with _RUN_LOCK:
            _RUN_STATE.update(
                {
                    "status": "idle" if exit_code == 0 else "failed",
                    "exit_code": exit_code,
                    "finished_at": _now(),
                }
            )

    threading.Thread(target=wait_for_exit, daemon=True).start()
    return state


def _manifest(out_dir: Path, prefix: str, exclude: tuple = ()) -> Optional[Dict[str, Any]]:
    candidates = [
        path
        for path in Path(out_dir).glob(f"{prefix}*.manifest.json")
        if not any(token in path.name for token in exclude)
    ]
    if not candidates:
        return None
    latest = max(candidates, key=lambda path: path.stat().st_mtime)
    payload = _read_json(latest)
    if payload is None:
        return None
    payload["_file"] = latest.name
    payload["_mtime"] = datetime.fromtimestamp(
        latest.stat().st_mtime, timezone.utc
    ).isoformat(timespec="seconds")
    return payload


def latest_payload(out_dir: Path) -> Dict[str, Any]:
    out_dir = Path(out_dir)
    return {
        "backtest": _read_json(out_dir / "latest.json"),
        "walkforward": _read_json(out_dir / "latest-walkforward.json"),
        "robustness": _read_json(out_dir / "latest-robustness.json"),
        "oos": _read_json(out_dir / "latest-oos.json"),
        "manifest": _manifest(out_dir, "baostock-", exclude=("-actions",)),
        "universe": _manifest(out_dir, "universe-"),
        "server": get_run_state(),
    }


def _run_summary(kind: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if kind == "backtest":
        metrics = payload.get("metrics") or {}
        return {
            "status": payload.get("status"),
            "total_return": metrics.get("total_return"),
            "sharpe": metrics.get("sharpe"),
            "max_drawdown": metrics.get("max_drawdown"),
            "filled_trades": metrics.get("filled_trades"),
        }
    if kind == "walkforward":
        metrics = payload.get("oos_metrics") or {}
        bias = payload.get("selection_bias") or {}
        return {
            "status": payload.get("status"),
            "windows": len(payload.get("windows") or []),
            "oos_total_return": metrics.get("total_return"),
            "oos_sharpe": metrics.get("sharpe"),
            "bonferroni_p_value": bias.get("bonferroni_p_value"),
            "deflated_sharpe_probability": bias.get("deflated_sharpe_probability"),
        }
    if kind == "oos":
        primary = payload.get("primary") or {}
        metrics = primary.get("metrics") or {}
        return {
            "status": payload.get("status"),
            "primary_lookback": payload.get("primary_lookback"),
            "total_return": metrics.get("total_return"),
            "sharpe": metrics.get("sharpe"),
            "max_drawdown": metrics.get("max_drawdown"),
        }
    scenarios = payload.get("scenarios") or []
    return {
        "status": payload.get("status"),
        "scenarios_ok": sum(1 for item in scenarios if item.get("status") == "OK"),
        "scenarios": len(scenarios),
        "verdict": payload.get("verdict") or {},
    }


def scan_runs(out_dir: Path, limit: int = 30) -> List[Dict[str, Any]]:
    out_dir = Path(out_dir)
    patterns = (
        ("backtest", "backtest-*.json"),
        ("walkforward", "walkforward-*.json"),
        ("robustness", "robustness-*.json"),
        ("oos", "frozen-oos-*.json"),
    )
    runs: List[Dict[str, Any]] = []
    for kind, pattern in patterns:
        for path in out_dir.glob(pattern):
            if path.name.startswith("latest"):
                continue
            payload = _read_json(path)
            if payload is None:
                continue
            runs.append(
                {
                    "kind": kind,
                    "run_id": payload.get("run_id", path.stem),
                    "file": path.name,
                    "mtime": datetime.fromtimestamp(
                        path.stat().st_mtime, timezone.utc
                    ).isoformat(timespec="seconds"),
                    "summary": _run_summary(kind, payload),
                }
            )
    runs.sort(key=lambda item: item["mtime"], reverse=True)
    return runs[:limit]


class DashboardHandler(BaseHTTPRequestHandler):
    out_dir: Path = DEFAULT_OUT
    config: Dict[str, Any] = DEFAULT_CONFIG
    dashboard_dir: Path = DASHBOARD_DIR

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, message: str, status: int) -> None:
        self._send_json({"error": message}, status=status)

    def _serve_file(self, relative: str) -> None:
        relative = relative.lstrip("/") or "index.html"
        candidate = (self.dashboard_dir / relative).resolve()
        base = self.dashboard_dir.resolve()
        if base != candidate and base not in candidate.parents:
            self.send_error(404)
            return
        if not candidate.is_file():
            self.send_error(404)
            return
        body = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix in (".html", ".js", ".css"):
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self._send_json({"status": "ok", "time": _now()})
            return
        if path == "/api/latest":
            self._send_json(latest_payload(self.out_dir))
            return
        if path == "/api/runs":
            self._send_json({"runs": scan_runs(self.out_dir)})
            return
        if path == "/api/status":
            self._send_json(get_run_state())
            return
        if path == "/api/config":
            self._send_json({"config": self.config})
            return
        if path == "/":
            self._serve_file("index.html")
            return
        self._serve_file(path)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/run":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 4096:
            self._send_error_json("invalid request body size", 413 if length > 4096 else 400)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_error_json("body must be JSON", 400)
            return
        kind = payload.get("kind") if isinstance(payload, dict) else None
        if not isinstance(kind, str):
            self._send_error_json("kind must be a string", 400)
            return
        try:
            state = start_run(kind, self.config, self.out_dir)
        except RunError as exc:
            self._send_error_json(str(exc), 400)
            return
        except RuntimeError as exc:
            self._send_error_json(str(exc), 409)
            return
        self._send_json({"started": True, "state": state}, status=202)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Polling /api/latest every few seconds should not flood the terminal.
        if args and "/api/" in str(args[0]):
            return
        super().log_message(fmt, *args)


def make_server(
    host: str,
    port: int,
    out_dir: Path,
    config_path: Optional[Path],
) -> ThreadingHTTPServer:
    handler = type(
        "ConfiguredDashboardHandler",
        (DashboardHandler,),
        {
            "out_dir": Path(out_dir),
            "config": load_config(config_path),
            "dashboard_dir": DASHBOARD_DIR,
        },
    )
    return ThreadingHTTPServer((host, port), handler)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="FlowCredit Quant local dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    args = parser.parse_args(argv)

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(
            "warning: this dashboard has no authentication; binding beyond "
            "localhost is not recommended.",
            file=sys.stderr,
        )

    server = None
    port = args.port
    for offset in range(10):
        candidate = args.port + offset
        try:
            server = make_server(
                args.host, candidate, Path(args.out), Path(args.config)
            )
            port = candidate
            break
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE:
                raise
            print(
                f"port {candidate} is in use; trying {candidate + 1}",
                file=sys.stderr,
            )
    if server is None:
        print("could not find a free port near the requested one", file=sys.stderr)
        return 1

    print(f"FlowCredit Quant dashboard: http://{args.host}:{port}")
    print("local only · post-run data · not live trading")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())