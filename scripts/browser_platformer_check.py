#!/usr/bin/env python3
from __future__ import annotations

import argparse
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_server(port: int, timeout_s: float = 10.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
            conn.request("GET", "/")
            resp = conn.getresponse()
            if 200 <= resp.status < 500:
                resp.read()
                conn.close()
                return
        except OSError:
            time.sleep(0.2)
        finally:
            try:
                conn.close()
            except Exception:
                pass
    raise RuntimeError(f"http server did not start on port {port}")


def find_chrome() -> str:
    candidates = [
        os.environ.get("MASKAGENT_BROWSER_BIN"),
        shutil.which("google-chrome"),
        shutil.which("google-chrome-stable"),
        shutil.which("chromium"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise RuntimeError("No supported browser found. Set MASKAGENT_BROWSER_BIN to Chrome or Edge.")


def fetch_page_source(url: str) -> str:
    conn = http.client.HTTPConnection("127.0.0.1", int(url.rsplit(":", 1)[1].split("/", 1)[0]), timeout=5)
    path = "/" + url.split("/", 3)[3] if "/" in url.split("://", 1)[1] else "/"
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="replace")
        if resp.status >= 400:
            raise RuntimeError(f"failed to fetch page source: HTTP {resp.status}")
        return body
    finally:
        conn.close()


def run_command(cmd: list[str], timeout_s: float) -> dict[str, object]:
    stdout_file = tempfile.NamedTemporaryFile(prefix="maskagent-browser-stdout-", delete=False)
    stderr_file = tempfile.NamedTemporaryFile(prefix="maskagent-browser-stderr-", delete=False)
    stdout_file.close()
    stderr_file.close()
    try:
        with open(stdout_file.name, "w", encoding="utf-8") as stdout_handle, open(
            stderr_file.name, "w", encoding="utf-8"
        ) as stderr_handle:
            proc = subprocess.Popen(
                cmd,
                text=True,
                stdout=stdout_handle,
                stderr=stderr_handle,
                start_new_session=True,
            )
            timed_out = False
            try:
                proc.wait(timeout=timeout_s)
            except subprocess.TimeoutExpired:
                timed_out = True
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)

        stdout = Path(stdout_file.name).read_text(encoding="utf-8", errors="replace")
        stderr = Path(stderr_file.name).read_text(encoding="utf-8", errors="replace")
        return {
            "returncode": proc.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "timedOut": timed_out,
        }
    finally:
        Path(stdout_file.name).unlink(missing_ok=True)
        Path(stderr_file.name).unlink(missing_ok=True)


def run_browser(browser_bin: str, url: str, screenshot_path: Path, dump_path: Path) -> dict[str, object]:
    common = [
        browser_bin,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--virtual-time-budget=3000",
    ]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        common.append("--no-sandbox")

    with tempfile.TemporaryDirectory(prefix="maskagent-browser-profile-") as profile_dir:
        screenshot_cmd = common + [
            f"--user-data-dir={profile_dir}",
            "--window-size=1440,960",
            f"--screenshot={screenshot_path}",
            url,
        ]
        screenshot_res = run_command(screenshot_cmd, timeout_s=20)
        if int(screenshot_res["returncode"]) != 0 and not screenshot_path.exists():
            raise RuntimeError(
                f"browser screenshot failed: {screenshot_res['stderr'] or screenshot_res['stdout']}"
            )

    page_source = fetch_page_source(url)
    with tempfile.TemporaryDirectory(prefix="maskagent-browser-profile-") as profile_dir:
        dump_cmd = common + [
            f"--user-data-dir={profile_dir}",
            "--dump-dom",
            url,
        ]
        dump_res = run_command(dump_cmd, timeout_s=15)
        dump_stdout = str(dump_res["stdout"]).strip()
        if int(dump_res["returncode"]) == 0 and dump_stdout:
            dump_path.write_text(dump_stdout, encoding="utf-8")
        else:
            dump_path.write_text(page_source, encoding="utf-8")
        return {
            "stdout": dump_stdout or page_source,
            "stderr": str(dump_res["stderr"]),
            "pageSource": page_source,
            "screenshotTimedOut": bool(screenshot_res["timedOut"]),
            "dumpTimedOut": bool(dump_res["timedOut"]),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a browser-level validation against a static platformer workspace.")
    parser.add_argument("workspace", help="Workspace directory containing index.html")
    parser.add_argument("--entry", default="index.html", help="Entry file to open")
    parser.add_argument("--output-dir", help="Directory to store browser artifacts")
    parser.add_argument(
        "--expect",
        action="append",
        default=["<canvas", "platformer", "move", "jump"],
        help="Case-insensitive text that must appear in the rendered DOM dump",
    )
    args = parser.parse_args()

    workspace = Path(args.workspace).expanduser().resolve()
    if not (workspace / args.entry).exists():
        print(f"missing entry file: {workspace / args.entry}", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else workspace / ".maskagent-browser-check"
    output_dir.mkdir(parents=True, exist_ok=True)
    screenshot_path = output_dir / "browser-check.png"
    dump_path = output_dir / "browser-check.dom.html"
    summary_path = output_dir / "browser-check.summary.json"

    port = pick_port()
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=str(workspace),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        wait_for_server(port)
        browser_bin = find_chrome()
        url = f"http://127.0.0.1:{port}/{args.entry}"
        browser_output = run_browser(browser_bin, url, screenshot_path, dump_path)
        dom_lower = browser_output["stdout"].lower()
        missing = [term for term in args.expect if term.lower() not in dom_lower]
        summary = {
            "ok": not missing and screenshot_path.exists(),
            "url": url,
            "browser": browser_bin,
            "workspace": str(workspace),
            "screenshot": str(screenshot_path),
            "domDump": str(dump_path),
            "screenshotTimedOut": browser_output["screenshotTimedOut"],
            "dumpTimedOut": browser_output["dumpTimedOut"],
            "missingTerms": missing,
        }
        summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        if missing:
            print(json.dumps(summary, indent=2), file=sys.stderr)
            return 1
        print(json.dumps(summary, indent=2))
        return 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
