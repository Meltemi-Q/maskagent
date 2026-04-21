from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from mission_runtime.cli import main


class FakeOpenAIHandler(BaseHTTPRequestHandler):
    content = "OK fake openai"

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", "0")))
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"choices": [{"message": {"content": self.content}}]}).encode())

    def log_message(self, fmt, *args):
        return


class FakeOpenAIJsonWorkerHandler(FakeOpenAIHandler):
    content = json.dumps({
        "status": "succeeded",
        "summary": "created marker from fake LLM worker",
        "files": [{"path": "llm-marker.txt", "content": "hello from fake llm\n"}],
        "commands": [],
        "openIssues": []
    })


class FakeAnthropicHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", "0")))
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"content": [{"type": "text", "text": "OK fake anthropic"}]}).encode())

    def log_message(self, fmt, *args):
        return


def server(handler, requests=1):
    s = HTTPServer(("127.0.0.1", 0), handler)
    s.timeout = 5
    def run():
        for _ in range(requests):
            s.handle_request()
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return s


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "missions"
        self.workspace = Path(self.tmp.name) / "workspace"
        self.workspace.mkdir()
        os.environ["MASKAGENT_HOME"] = str(self.home)

    def tearDown(self):
        os.environ.pop("MASKAGENT_HOME", None)
        os.environ.pop("MISSION_HOME", None)
        os.environ.pop("FAKE_API_KEY", None)
        self.tmp.cleanup()

    def md(self):
        ds = list(self.home.iterdir())
        self.assertEqual(len(ds), 1)
        return ds[0]

    def read(self, p):
        return json.loads(Path(p).read_text())

    def test_layout_and_secret_policy(self):
        self.assertEqual(main(["init", "--name", "demo", "--goal", "plan", "--workspace", str(self.workspace), "--adapter-id", "fake", "--provider-type", "openai_compatible", "--base-url", "http://example.test/v1", "--api-key-env", "FAKE_API_KEY", "--model", "fake-model"]), 0)
        md = self.md()
        for n in ["mission.md", "features.json", "state.json", "validation-state.json", "model-settings.json", "runtime-custom-models.json", "progress_log.jsonl", "worker-transcripts.jsonl"]:
            self.assertTrue((md / n).exists(), n)
        self.assertTrue((md / "handoffs").is_dir())
        self.assertTrue((md / "evidence").is_dir())
        text = (md / "runtime-custom-models.json").read_text()
        self.assertIn("FAKE_API_KEY", text)
        self.assertNotIn("sk-", text)
        self.assertIn("lastReviewedHandoffCount", self.read(md / "state.json"))
        self.assertEqual(self.read(md / "features.json")["steps"][0]["type"], "llm_worker")


    def test_default_home_is_maskagent_not_factory(self):
        os.environ.pop("MASKAGENT_HOME", None)
        os.environ.pop("MISSION_HOME", None)
        old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.tmp.name
        try:
            self.assertEqual(main(["init", "--name", "default-home", "--goal", "check path", "--workspace", str(self.workspace), "--step-command", "true"]), 0)
            self.assertTrue((Path(self.tmp.name) / ".maskagent" / "missions").is_dir())
            self.assertFalse((Path(self.tmp.name) / ".factory").exists())
        finally:
            if old_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old_home
            os.environ["MASKAGENT_HOME"] = str(self.home)

    def test_shell_validator_acceptance(self):
        self.assertEqual(main(["init", "--name", "shell", "--goal", "write marker", "--workspace", str(self.workspace), "--step-command", "printf ok > marker.txt", "--validate", "test -f marker.txt", "--accept", "grep -q ok marker.txt"]), 0)
        md = self.md()
        self.assertEqual(main(["run", md.name, "--max-steps", "5"]), 0)
        self.assertTrue((self.workspace / "marker.txt").exists())
        self.assertGreater(len(list((md / "handoffs").glob("*.json"))), 0)
        self.assertEqual(self.read(md / "validation-state.json")["assertions"]["step-shell"]["status"], "pass")
        self.assertEqual(main(["accept", md.name]), 0)
        self.assertEqual(self.read(md / "state.json")["state"], "accepted")

    def test_external_cli_validator_acceptance(self):
        command = f"{sys.executable} -c \"from pathlib import Path; Path('marker.txt').write_text('ok\\\\n', encoding='utf-8')\""
        self.assertEqual(
            main([
                "init",
                "--name", "external-cli",
                "--goal", "write marker through external cli",
                "--workspace", str(self.workspace),
                "--worker-command", command,
                "--validate", "grep -q ok marker.txt",
                "--accept", "test -f marker.txt",
            ]),
            0,
        )
        md = self.md()
        self.assertEqual(main(["run", md.name, "--max-steps", "5"]), 0)
        self.assertTrue((self.workspace / "marker.txt").exists())
        self.assertEqual(self.read(md / "validation-state.json")["assertions"]["step-worker"]["status"], "pass")
        self.assertEqual(main(["accept", md.name]), 0)
        self.assertEqual(self.read(md / "state.json")["state"], "accepted")

    def test_llm_json_worker_writes_files_and_validates(self):
        os.environ["FAKE_API_KEY"] = "fake-token-not-written"
        so = server(FakeOpenAIJsonWorkerHandler)
        self.addCleanup(so.server_close)
        self.assertEqual(main(["init", "--name", "llm", "--goal", "create a marker using LLM JSON worker", "--workspace", str(self.workspace), "--adapter-id", "fake-openai", "--provider-type", "openai_compatible", "--base-url", f"http://127.0.0.1:{so.server_port}/v1", "--api-key-env", "FAKE_API_KEY", "--model", "fake", "--validate", "grep -q 'fake llm' llm-marker.txt", "--accept", "test -f llm-marker.txt"]), 0)
        md = self.md()
        self.assertEqual(main(["run", md.name, "--max-steps", "3"]), 0)
        self.assertEqual((self.workspace / "llm-marker.txt").read_text(), "hello from fake llm\n")
        self.assertEqual(self.read(md / "validation-state.json")["assertions"]["step-worker"]["status"], "pass")
        attempts = (md / "attempts.jsonl").read_text()
        self.assertIn("llm_json_delta", attempts)
        self.assertNotIn("fake-token-not-written", (md / "worker-transcripts.jsonl").read_text())

    def test_pause_resume_restart_events(self):
        self.assertEqual(main(["init", "--name", "pause", "--goal", "noop", "--workspace", str(self.workspace), "--step-command", "true", "--validate", "true"]), 0)
        md = self.md()
        self.assertEqual(main(["pause", md.name]), 0)
        self.assertEqual(main(["run", md.name]), 0)
        log = (md / "progress_log.jsonl").read_text()
        self.assertIn("mission_paused", log)
        self.assertEqual(main(["resume", md.name]), 0)
        self.assertEqual(main(["restart", md.name]), 0)
        log = (md / "progress_log.jsonl").read_text()
        self.assertIn("mission_resumed", log)
        self.assertIn("orphan_cleanup", log)

    def test_pause_during_running_step_requeues_current_step(self):
        command = (
            f"{sys.executable} -c 'import pathlib,time; "
            "time.sleep(5); "
            "pathlib.Path(\"marker.txt\").write_text(\"ok\\n\", encoding=\"utf-8\")'"
        )
        self.assertEqual(
            main([
                "init",
                "--name", "pause-running-step",
                "--goal", "pause and resume the active worker",
                "--workspace", str(self.workspace),
                "--step-command", command,
                "--validate", "grep -q ok marker.txt",
                "--accept", "test -f marker.txt",
            ]),
            0,
        )
        md = self.md()
        result = {}
        thread = threading.Thread(
            target=lambda: result.setdefault("code", main(["run", md.name, "--max-steps", "2"])),
            daemon=True,
        )
        thread.start()
        time.sleep(0.5)
        self.assertEqual(main(["pause", md.name]), 0)
        thread.join(timeout=10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result.get("code"), 0)

        paused_state = self.read(md / "state.json")
        paused_features = self.read(md / "features.json")
        paused_step = next(x for x in paused_features["steps"] if x["stepId"] == "step-shell")
        self.assertEqual(paused_state["state"], "paused")
        self.assertEqual(paused_state["resumeFrom"], "step-shell")
        self.assertEqual(paused_step["status"], "pending")
        self.assertEqual(paused_step["attemptCount"], 0)
        self.assertFalse((self.workspace / "marker.txt").exists())

        self.assertEqual(main(["resume", md.name, "--run", "--max-steps", "2"]), 0)
        self.assertEqual(main(["accept", md.name]), 0)
        self.assertEqual((self.workspace / "marker.txt").read_text(), "ok\n")

    def test_fake_openai_and_anthropic_adapters(self):
        os.environ["FAKE_API_KEY"] = "fake-token-not-written"
        so = server(FakeOpenAIHandler)
        self.addCleanup(so.server_close)
        self.assertEqual(main(["init", "--name", "adapter", "--goal", "test", "--workspace", str(self.workspace), "--adapter-id", "fake-openai", "--provider-type", "openai_compatible", "--base-url", f"http://127.0.0.1:{so.server_port}/v1", "--api-key-env", "FAKE_API_KEY", "--model", "fake"]), 0)
        md = self.md()
        self.assertEqual(main(["adapters", "test", md.name, "fake-openai"]), 0)
        sa = server(FakeAnthropicHandler)
        self.addCleanup(sa.server_close)
        self.assertEqual(main(["adapters", "add", md.name, "--adapter-id", "fake-anthropic", "--provider-type", "anthropic_compatible", "--base-url", f"http://127.0.0.1:{sa.server_port}", "--api-key-env", "FAKE_API_KEY", "--model", "fake"]), 0)
        self.assertEqual(main(["adapters", "test", md.name, "fake-anthropic"]), 0)
        self.assertNotIn("fake-token-not-written", (md / "worker-transcripts.jsonl").read_text())


if __name__ == "__main__":
    unittest.main()
