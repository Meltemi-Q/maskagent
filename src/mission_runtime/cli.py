from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VERSION = "0.3.0"
SECRET_RE = [
    re.compile(r"sk-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"(Bearer\s+)[A-Za-z0-9_\-.]{10,}", re.I),
    re.compile(r"(x-api-key\s*[:=]\s*)[A-Za-z0-9_\-.]{10,}", re.I),
    re.compile(r"(api[_-]?key\s*[:=]\s*)[A-Za-z0-9_\-.]{10,}", re.I),
]
TRANSIENT_ERRORS = {"timeout", "rate_limited", "transient_provider_error"}


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def mid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def home() -> Path:
    """Return the mission state root.

    MaskAgent's product-owned default is ~/.maskagent/missions.
    MASKAGENT_HOME is the preferred override. MISSION_HOME is retained as a
    legacy/test alias so older scripts do not break, but new docs should use
    MASKAGENT_HOME.
    """
    return Path(
        os.environ.get(
            "MASKAGENT_HOME",
            os.environ.get("MISSION_HOME", str(Path.home() / ".maskagent" / "missions")),
        )
    ).expanduser()


def ensure(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def load(p: Path, default: Any = None) -> Any:
    if not p.exists():
        return default
    return json.loads(p.read_text(encoding="utf-8"))


def save(p: Path, data: Any) -> None:
    ensure(p.parent)
    tmp = p.with_suffix(p.suffix + f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, p)


def append_jsonl(p: Path, data: dict[str, Any]) -> None:
    ensure(p.parent)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False) + "\n")


def redact_text(s: str | None) -> str:
    s = "" if s is None else str(s)
    for r in SECRET_RE:
        s = r.sub(lambda m: (m.group(1) + "[REDACTED]") if m.groups() else "[REDACTED]", s)
    return s


def redact(v: Any) -> Any:
    if isinstance(v, str):
        return redact_text(v)
    if isinstance(v, list):
        return [redact(x) for x in v]
    if isinstance(v, dict):
        out: dict[str, Any] = {}
        for k, val in v.items():
            if re.search(r"(secret|token|password|authorization|api.?key)$", str(k), re.I):
                out[k] = val if isinstance(val, str) and (val.endswith("_KEY") or val.startswith("${")) else "[REDACTED]"
            else:
                out[k] = redact(val)
        return out
    return v


def event(md: Path, name: str, **payload: Any) -> None:
    append_jsonl(md / "progress_log.jsonl", redact({
        "ts": now(), "event": name, "runtime": {"pid": os.getpid(), "host": socket.gethostname()}, **payload
    }))


def short(s: str | None, limit: int = 4000) -> str:
    s = redact_text(s or "")
    return s if len(s) <= limit else s[:limit] + f"\n...[truncated {len(s)-limit} chars]"


def terminate_process_tree(p: subprocess.Popen[str], wait_s: float = 5.0) -> None:
    try:
        os.killpg(p.pid, signal.SIGTERM)
    except Exception:
        try:
            p.terminate()
        except Exception:
            return
    try:
        p.wait(timeout=wait_s)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except Exception:
        try:
            p.kill()
        except Exception:
            return
    try:
        p.wait(timeout=wait_s)
    except subprocess.TimeoutExpired:
        pass


def run_shell(cmd: str, cwd: Path, timeout_s: int = 600, pause_file: Path | None = None) -> dict[str, Any]:
    t = time.time()
    p = subprocess.Popen(
        cmd,
        shell=True,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    timed_out = False
    paused = False
    while True:
        try:
            stdout, stderr = p.communicate(timeout=0.2)
            break
        except subprocess.TimeoutExpired:
            if pause_file and pause_file.exists():
                paused = True
                terminate_process_tree(p)
                stdout, stderr = p.communicate()
                break
            if time.time() - t >= timeout_s:
                timed_out = True
                terminate_process_tree(p)
                stdout, stderr = p.communicate()
                break
    if timed_out:
        stderr = (stderr or "") + "\n[TIMEOUT]"
    if paused:
        stderr = (stderr or "") + "\n[PAUSED]"
    return {
        "command": cmd,
        "cwd": str(cwd),
        "exitCode": 130 if paused else 124 if timed_out else p.returncode,
        "stdout": short(stdout),
        "stderr": short(stderr),
        "durationMs": int((time.time() - t) * 1000),
        "timedOut": timed_out,
        "paused": paused,
    }


def resolve(arg: str | None) -> Path:
    h = home()
    if arg:
        p = Path(arg).expanduser()
        if p.exists():
            return p.resolve()
        c = h / arg
        if c.exists():
            return c.resolve()
        ms = list(h.glob(f"{arg}*")) if h.exists() else []
        if len(ms) == 1:
            return ms[0].resolve()
        raise FileNotFoundError(f"mission not found: {arg}")
    ms = sorted([p for p in h.iterdir() if p.is_dir() and (p / "state.json").exists()], key=lambda p: p.stat().st_mtime, reverse=True) if h.exists() else []
    if not ms:
        raise FileNotFoundError(f"no missions in {h}")
    return ms[0].resolve()


def layout(md: Path) -> None:
    ensure(md); ensure(md / "handoffs"); ensure(md / "evidence"); ensure(md / "artifacts")
    for n in ["progress_log.jsonl", "worker-transcripts.jsonl", "attempts.jsonl", "validation_log.jsonl"]:
        (md / n).touch(exist_ok=True)


def state(md: Path) -> dict[str, Any]:
    return load(md / "state.json", {})


def features(md: Path) -> dict[str, Any]:
    return load(md / "features.json", {"version": 1, "steps": []})


def valstate(md: Path) -> dict[str, Any]:
    return load(md / "validation-state.json", {"version": 1, "assertions": {}})


def registry(md: Path) -> dict[str, Any]:
    return load(md / "runtime-custom-models.json", {"version": 1, "customModels": []})


def acquire(md: Path, stale: bool = False) -> str | None:
    lock = md / "run.lock"
    if lock.exists():
        old = load(lock, {})
        pid = old.get("pid")
        alive = False
        if isinstance(pid, int):
            try:
                os.kill(pid, 0); alive = True
            except OSError:
                alive = False
        if alive and not stale:
            return f"mission locked by pid={pid}"
        event(md, "worker_failed", reason="orphan_cleanup", previousLock=old)
        lock.unlink(missing_ok=True)
    save(lock, {"pid": os.getpid(), "host": socket.gethostname(), "createdAt": now()})
    return None


def release(md: Path) -> None:
    (md / "run.lock").unlink(missing_ok=True)


def role_adapter_id(md: Path, role: str, explicit: str | None = None) -> str | None:
    if explicit:
        return explicit
    s = load(md / "model-settings.json", {})
    roles = s.get("roleAssignments") or {}
    return roles.get(role) or s.get(f"{role}Model") or s.get("workerModel") or s.get("defaultAdapterRef")


def adapter(md: Path, aid: str | None) -> dict[str, Any]:
    aid = aid or role_adapter_id(md, "worker")
    for a in registry(md).get("customModels", []):
        if a.get("id") == aid or a.get("adapterId") == aid:
            if a.get("enabled", True) is False:
                raise RuntimeError(f"capability_unsupported:adapter disabled: {aid}")
            return a
    raise RuntimeError(f"adapter not found: {aid}")


def save_adapter(md: Path, a: dict[str, Any]) -> None:
    if any(k in a and a.get(k) for k in ["apiKey", "key", "token"]):
        raise ValueError("raw API keys are not allowed; use apiKeyEnvVar")
    r = registry(md); items = r.setdefault("customModels", [])
    a.setdefault("adapterId", a.get("id")); a.setdefault("enabled", True)
    a.setdefault("retryPolicy", {"maxRetries": 1, "backoffMs": 500}); a.setdefault("capabilityFlags", [])
    for i, x in enumerate(items):
        if x.get("id") == a.get("id"):
            items[i] = {**x, **a}; save(md / "runtime-custom-models.json", r); return
    items.append(a); save(md / "runtime-custom-models.json", r)


def http_json(url: str, headers: dict[str, str], payload: dict[str, Any], timeout_s: float) -> dict[str, Any]:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type":"application/json", **headers}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        cat = "auth_error" if e.code == 401 else "permission_error" if e.code == 403 else "model_not_found" if e.code == 404 else "rate_limited" if e.code == 429 else "transient_provider_error" if e.code >= 500 or e.code == 529 else "invalid_request"
        raise RuntimeError(f"{cat}:{e.code}:{short(body, 800)}")
    except TimeoutError as e:
        raise RuntimeError(f"timeout:{e}")
    except Exception as e:
        raise RuntimeError(f"transient_provider_error:{e}")


def _call_adapter_once(md: Path, a: dict[str, Any], prompt: str, role: str) -> dict[str, Any]:
    provider = a.get("providerType") or a.get("provider") or "openai_compatible"
    model = a.get("modelName") or a.get("model")
    timeout_s = float(a.get("timeoutMs", 30000)) / 1000
    t = time.time()
    if provider in ["openai_compatible", "custom_gateway"]:
        key = os.environ.get(a.get("apiKeyEnvVar") or "")
        if not key:
            raise RuntimeError(f"auth_error:missing env {a.get('apiKeyEnvVar')}")
        data = http_json((a.get("baseUrl") or "").rstrip("/") + "/chat/completions", {"Authorization": f"Bearer {key}"}, {"model": model, "messages": [{"role":"user", "content": prompt}]}, timeout_s)
        content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
    elif provider == "anthropic_compatible":
        key = os.environ.get(a.get("apiKeyEnvVar") or "")
        if not key:
            raise RuntimeError(f"auth_error:missing env {a.get('apiKeyEnvVar')}")
        data = http_json((a.get("baseUrl") or "").rstrip("/") + "/v1/messages", {"x-api-key": key, "anthropic-version":"2023-06-01"}, {"model": model, "max_tokens": int(a.get("maxOutputTokens") or 2048), "messages": [{"role":"user", "content": prompt}]}, timeout_s)
        content = "".join([p.get("text", "") if isinstance(p, dict) else str(p) for p in (data.get("content") if isinstance(data.get("content"), list) else [data.get("content", "")])])
    elif provider in ["cli_command", "external_cli"]:
        cmd = a.get("command") or a.get("commandTemplate")
        if not cmd:
            raise RuntimeError("invalid_request:missing command")
        pp = md / "evidence" / f"{mid('adapter-prompt')}.md"
        pp.write_text(prompt, encoding="utf-8")
        res = run_shell(cmd.format(prompt_file=shlex.quote(str(pp)), prompt=shlex.quote(prompt), raw_prompt=prompt, mission_dir=shlex.quote(str(md))), md, int(timeout_s))
        if res["exitCode"] != 0:
            raise RuntimeError(f"tool_error:{res['exitCode']}:{res['stderr'] or res['stdout']}")
        content = res["stdout"]
    else:
        raise RuntimeError(f"capability_unsupported:{provider}")
    return {"adapterId": a.get("id"), "providerType": provider, "model": model, "content": content, "durationMs": int((time.time()-t)*1000)}


def error_category(e: Exception) -> str:
    msg = str(e)
    return msg.split(":", 1)[0] if ":" in msg else "tool_error"


def call_adapter(md: Path, aid: str | None, prompt: str, role: str = "worker") -> dict[str, Any]:
    first = adapter(md, aid or role_adapter_id(md, role))
    candidates = [first]
    for fid in first.get("fallbackAdapterIds") or []:
        try:
            candidates.append(adapter(md, fid))
        except Exception as e:
            event(md, "adapter_fallback_unavailable", adapterId=fid, error=short(str(e), 500))
    last: Exception | None = None
    for a in candidates:
        rp = a.get("retryPolicy") or {}
        attempts = int(rp.get("maxRetries", 0)) + 1
        backoff = int(rp.get("backoffMs", 250)) / 1000
        for n in range(attempts):
            try:
                out = _call_adapter_once(md, a, prompt, role)
                append_jsonl(md / "worker-transcripts.jsonl", {"ts": now(), "kind":"adapter_call", "role":role, "adapterId": a.get("id"), "model": out.get("model"), "contentChars": len(out.get("content") or ""), "attempt": n+1})
                if n or a is not first:
                    event(md, "adapter_call_recovered", role=role, adapterId=a.get("id"), attempt=n+1)
                return out
            except Exception as e:
                last = e
                cat = error_category(e)
                event(md, "adapter_call_failed", role=role, adapterId=a.get("id"), errorCategory=cat, attempt=n+1, retryable=cat in TRANSIENT_ERRORS)
                if cat not in TRANSIENT_ERRORS or n + 1 >= attempts:
                    break
                time.sleep(backoff * (2 ** n))
    assert last is not None
    raise last


def worker_prompt(s: dict[str, Any], step: dict[str, Any], mission_md: str, retry: dict[str, Any]) -> str:
    return "\n".join([
        "You are a bounded Worker inside a mission runtime. Produce evidence; validator decides acceptance.",
        "# Mission", mission_md[:12000],
        "# State", json.dumps({k:s.get(k) for k in ['missionId','phase','status','resumeFrom']}, ensure_ascii=False),
        "# Step", json.dumps(step, ensure_ascii=False, indent=2),
        "# Retry", json.dumps(retry, ensure_ascii=False),
    ])


def llm_worker_prompt(s: dict[str, Any], step: dict[str, Any], mission_md: str, retry: dict[str, Any]) -> str:
    schema = {
        "status": "succeeded|partial|failed|blocked",
        "summary": "short human readable summary",
        "files": [{"path": "relative/path/in/workspace", "content": "complete file content", "mode": "0644"}],
        "commands": [{"command": "optional shell command", "purpose": "why", "timeoutSeconds": 120}],
        "openIssues": ["remaining risks or blockers"]
    }
    return "\n".join([
        "You are the Worker of a local mission orchestration runtime.",
        "Return ONLY one strict JSON object. Do not use markdown fences unless unavoidable.",
        "Your JSON may write files under the workspace. Never use absolute paths, '..', or .git paths.",
        "Commands are optional and may be skipped unless the runtime explicitly allows model commands.",
        "The validator, not you, decides final acceptance. Provide concrete evidence-oriented output.",
        "# Required JSON schema", json.dumps(schema, ensure_ascii=False, indent=2),
        "# Mission", mission_md[:12000],
        "# Runtime state", json.dumps({k:s.get(k) for k in ['missionId','phase','status','resumeFrom','workingDirectory']}, ensure_ascii=False, indent=2),
        "# Current step", json.dumps(step, ensure_ascii=False, indent=2),
        "# Retry context", json.dumps(retry, ensure_ascii=False, indent=2),
    ])


def extract_json_object(text: str) -> dict[str, Any] | None:
    text = text.strip()
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S | re.I)
    candidates = [fenced.group(1)] if fenced else []
    candidates.append(text)
    dec = json.JSONDecoder()
    for c in candidates:
        s = c.strip()
        for i, ch in enumerate(s):
            if ch != "{":
                continue
            try:
                obj, _ = dec.raw_decode(s[i:])
                return obj if isinstance(obj, dict) else None
            except json.JSONDecodeError:
                continue
    return None


def workspace_path(wd: Path, rel: str) -> Path:
    if not rel or Path(rel).is_absolute():
        raise ValueError(f"unsafe path: {rel!r}")
    parts = Path(rel).parts
    if ".." in parts or ".git" in parts:
        raise ValueError(f"unsafe path: {rel!r}")
    target = (wd / rel).resolve()
    root = wd.resolve()
    if os.path.commonpath([str(root), str(target)]) != str(root):
        raise ValueError(f"path escapes workspace: {rel!r}")
    return target


def write_cmd_evidence(md: Path, prefix: str, res: dict[str, Any]) -> list[str]:
    base = md / "evidence" / prefix
    paths = [base.with_suffix(".stdout.txt"), base.with_suffix(".stderr.txt"), base.with_suffix(".json")]
    paths[0].write_text(res.get("stdout", ""), encoding="utf-8")
    paths[1].write_text(res.get("stderr", ""), encoding="utf-8")
    save(paths[2], res)
    return [str(p.relative_to(md)) for p in paths]


def apply_llm_worker_json(md: Path, wd: Path, aid: str, payload: dict[str, Any], step: dict[str, Any]) -> dict[str, Any]:
    refs: list[str] = []
    actions: list[dict[str, Any]] = []
    issues: list[str] = []
    failure_class: str | None = None
    allow_commands = bool(step.get("allowModelCommands"))

    for i, f in enumerate(payload.get("files") or []):
        if not isinstance(f, dict):
            issues.append(f"file[{i}] is not an object")
            failure_class = failure_class or "invalid_worker_output"
            continue
        rel = str(f.get("path") or "")
        try:
            target = workspace_path(wd, rel)
            ensure(target.parent)
            content = str(f.get("content") or "")
            target.write_text(content, encoding="utf-8")
            if f.get("mode"):
                try:
                    os.chmod(target, int(str(f["mode"]), 8))
                except Exception as e:
                    issues.append(f"chmod skipped for {rel}: {e}")
            meta = {"kind": "file_write", "path": rel, "bytes": len(content.encode('utf-8'))}
            actions.append(meta)
            ep = md / "evidence" / f"{aid}-file-{i+1}.json"
            save(ep, meta)
            refs.append(str(ep.relative_to(md)))
        except Exception as e:
            issues.append(str(e))
            failure_class = failure_class or "unsafe_file_operation"

    for i, c in enumerate(payload.get("commands") or []):
        cmd = c.get("command") if isinstance(c, dict) else str(c)
        if not cmd:
            continue
        if not allow_commands:
            actions.append({"kind": "model_command_skipped", "command": cmd, "reason": "allowModelCommands=false"})
            continue
        timeout_s = int(c.get("timeoutSeconds", 600)) if isinstance(c, dict) else 600
        res = run_shell(cmd, wd, timeout_s)
        refs += write_cmd_evidence(md, f"{aid}-model-command-{i+1}", res)
        actions.append({"kind": "model_command", "command": cmd, "exitCode": res["exitCode"]})
        if res["exitCode"] != 0:
            failure_class = "environment_error" if res.get("timedOut") else "tool_error"
            issues.append(f"model command failed: {cmd} exit={res['exitCode']}")

    claimed = str(payload.get("status") or "succeeded").lower()
    if claimed not in {"succeeded", "partial", "failed", "blocked"}:
        claimed = "partial"
    if failure_class:
        status = "failed"
    elif claimed in {"failed", "blocked"}:
        status = "blocked" if claimed == "blocked" else "failed"
        failure_class = claimed
    elif claimed == "partial":
        status = "partial"
    else:
        status = "succeeded"

    return {
        "status": status,
        "actions": actions,
        "artifactRefs": refs,
        "summary": short(str(payload.get("summary") or "LLM worker produced structured output"), 1500),
        "openIssues": list(payload.get("openIssues") or []) + issues,
        "failureClass": failure_class,
    }


def git_summary(wd: Path) -> dict[str, Any]:
    if not (wd / ".git").exists():
        return {"isGitRepo": False}
    return {"isGitRepo": True, "statusShort": run_shell("git status --short", wd, 30)["stdout"], "diffStat": run_shell("git diff --stat", wd, 30)["stdout"]}


def execute_worker(md: Path, step: dict[str, Any], s: dict[str, Any]) -> dict[str, Any]:
    aid = mid("attempt")
    wd = Path(s.get("workingDirectory") or ".").expanduser().resolve()
    pause_file = md / "pause.requested"
    refs: list[str] = []
    actions: list[dict[str, Any]] = []
    status = "failed"
    fc: str | None = None
    fd = ""
    summary = ""
    issues: list[str] = []
    mission_md = (md/"mission.md").read_text(encoding="utf-8") if (md/"mission.md").exists() else ""
    try:
        typ = step.get("type", "llm_worker")
        if typ in ["shell", "exec"]:
            res = run_shell(step.get("command") or "", wd, int(step.get("timeoutSeconds") or 600), pause_file)
            refs += write_cmd_evidence(md, f"{aid}-worker", res)
            actions.append({"kind":"shell", "command": step.get("command"), "exitCode": res["exitCode"]})
            if res.get("paused"):
                status="paused"; fc="pause_requested"; summary="Worker paused by operator request"
            elif res["exitCode"] == 0:
                status="succeeded"; summary=f"Command exited 0: {step.get('command')}"
            else:
                fc="environment_error" if res.get("timedOut") else "tool_error"; fd=f"Command exited {res['exitCode']}"; summary=fd; issues.append(fd)
        elif typ in ["external_cli", "claude_code", "codex"]:
            prompt = worker_prompt(s, step, mission_md, {"attemptCount": step.get("attemptCount",0), "previousFailureClass": step.get("failureClass")})
            pp = md / "evidence" / f"{aid}-prompt.md"; pp.write_text(prompt, encoding="utf-8"); refs.append(str(pp.relative_to(md)))
            cmd = (step.get("commandTemplate") or step.get("command") or "").format(prompt_file=shlex.quote(str(pp)), prompt=shlex.quote(prompt), workspace=shlex.quote(str(wd)), mission_dir=shlex.quote(str(md)), raw_prompt=prompt)
            res = run_shell(cmd, wd, int(step.get("timeoutSeconds") or 1800), pause_file)
            refs += write_cmd_evidence(md, f"{aid}-external-cli", res)
            actions.append({"kind":"external_cli", "commandTemplate": step.get("commandTemplate") or step.get("command"), "exitCode": res["exitCode"]})
            if res.get("paused"):
                status="paused"; fc="pause_requested"; summary="External CLI worker paused by operator request"
            elif res["exitCode"] == 0:
                status="succeeded"; summary=short(res["stdout"] or "External CLI completed", 1500)
            else:
                fc="environment_error" if res.get("timedOut") else "tool_error"; fd=f"External CLI exited {res['exitCode']}"; summary=fd; issues.append(short(res["stderr"] or res["stdout"], 1200))
        elif typ in ["llm_worker", "model_patch", "model"]:
            prompt = llm_worker_prompt(s, step, mission_md, {"attemptCount": step.get("attemptCount",0), "previousFailureClass": step.get("failureClass")})
            resp = call_adapter(md, step.get("adapterRef") or step.get("adapterId"), prompt, "worker")
            raw_path = md / "evidence" / f"{aid}-model-output.md"
            raw_path.write_text(resp["content"], encoding="utf-8")
            refs.append(str(raw_path.relative_to(md)))
            actions.append({"kind":"model_call", "adapterId": resp.get("adapterId"), "model": resp.get("model"), "workerMode":"json_delta"})
            payload = extract_json_object(resp["content"])
            if not payload:
                fc="invalid_worker_output"; fd="model did not return a JSON object"; summary=fd; issues.append(fd); status="failed"
            else:
                parsed_path = md / "evidence" / f"{aid}-model-json.json"
                save(parsed_path, payload); refs.append(str(parsed_path.relative_to(md)))
                applied = apply_llm_worker_json(md, wd, aid, payload, step)
                refs += applied["artifactRefs"]; actions += applied["actions"]
                status = applied["status"]; fc = applied["failureClass"]; summary = applied["summary"]; issues += applied["openIssues"]
                if status == "partial" and not fc:
                    fc = "partial_completion"
        elif typ in ["model_plan"]:
            resp = call_adapter(md, step.get("adapterRef") or step.get("adapterId"), worker_prompt(s, step, mission_md, {}), "worker")
            p = md / "evidence" / f"{aid}-model-plan.md"; p.write_text(resp["content"], encoding="utf-8"); refs.append(str(p.relative_to(md)))
            actions.append({"kind":"model_call", "adapterId": resp.get("adapterId"), "model": resp.get("model"), "workerMode":"plan_only"})
            if resp["content"].strip(): status="succeeded"; summary=short(resp["content"], 1500)
            else: fc="no_effect_change"; fd="empty model response"; summary=fd; issues.append(fd)
        elif typ in ["noop", "manual"]:
            p = md / "evidence" / f"{aid}-noop.txt"; p.write_text(step.get("note") or "No-op worker recorded", encoding="utf-8"); refs.append(str(p.relative_to(md)))
            actions.append({"kind":"noop"}); status="succeeded"; summary="No-op worker recorded"
        else:
            raise RuntimeError(f"unsupported step type {typ}")
    except Exception as e:
        fc = error_category(e); fd = short(str(e)); summary = fd; issues.append(fd)
    attempt = {"attemptId": aid, "stepId": step.get("stepId"), "intent": step.get("objective") or step.get("title"), "strategy": step.get("strategy") or ("llm_json_delta" if step.get("type") in ["llm_worker", "model_patch", "model"] else "default"), "adapterRef": step.get("adapterRef") or role_adapter_id(md, "worker"), "status": status, "startedAt": now(), "endedAt": now(), "actionsTaken": actions, "artifactRefs": refs, "toolSummary": actions, "outputSummary": summary, "diffSummary": git_summary(wd), "validatorOutcome": None, "failureClass": fc, "failureDetail": fd, "claimedOutcome": summary if status == "succeeded" else "", "openIssues": issues, "nextRecommendation": "validator_review" if status == "succeeded" else "retry_with_changed_strategy"}
    append_jsonl(md / "attempts.jsonl", attempt)
    append_jsonl(md / "worker-transcripts.jsonl", {"ts": now(), "kind":"worker_attempt", "attemptId": aid, "stepId": step.get("stepId"), "status": status, "summary": summary})
    return attempt


def handoff(md: Path, attempt: dict[str, Any], step: dict[str, Any]) -> dict[str, Any]:
    n = len(list((md/"handoffs").glob("*.json"))) + 1
    h = {"handoffId": f"handoff-{n:04d}", "attemptId": attempt["attemptId"], "stepId": step.get("stepId"), "createdAt": now(), "successState": "success" if attempt["status"] == "succeeded" else "partial" if attempt["status"] == "partial" else "failure", "returnToOrchestrator": True, "commitId": None, "validatorsPassed": False, "salientSummary": attempt["outputSummary"], "whatWasImplemented": attempt.get("claimedOutcome"), "whatWasLeftUndone": attempt.get("openIssues", []), "verification": {"commands": [a for a in attempt.get("actionsTaken", []) if "exitCode" in a], "observations": attempt["outputSummary"]}, "discoveredIssues": attempt.get("openIssues", []), "artifactRefs": attempt.get("artifactRefs", [])}
    save(md / "handoffs" / f"{n:04d}-{attempt['attemptId']}.json", h)
    return h


def checks_for(step: dict[str, Any], s: dict[str, Any]) -> list[dict[str, Any]]:
    cs=[]
    for i,c in enumerate(step.get("checks") or []):
        cs.append({"name": f"check-{i+1}", "kind":"command", "required": True, **(c if isinstance(c,dict) else {"command":c})})
    if step.get("validateCommand"):
        cs.append({"name":"step-validate-command", "kind":"command", "command": step["validateCommand"], "required": True})
    if step.get("type") == "acceptance" and not cs:
        cs = (s.get("acceptancePolicy") or {}).get("checks") or []
    return cs


def validate(md: Path, step: dict[str, Any], attempt: dict[str, Any], s: dict[str, Any]) -> dict[str, Any]:
    vid=mid("validation"); wd=Path(s.get("workingDirectory") or ".").expanduser().resolve(); cs=checks_for(step,s); ev=[]; cr=[]
    result = "pass" if attempt.get("status") == "succeeded" and (attempt.get("artifactRefs") or cs) else ("environment_error" if attempt.get("failureClass") == "environment_error" else "fail" if attempt.get("status") not in ["succeeded"] else "insufficient_evidence")
    fc = None if result == "pass" else attempt.get("failureClass") or result; summary = "Worker produced evidence."
    for c in cs:
        if c.get("kind","command") != "command" or not c.get("command"):
            cr.append({"name": c.get("name"), "status":"skipped", "reason":"unsupported_or_missing_command"})
            if c.get("required", True): result="requires_human"; fc="unsupported_check"; summary="Required check unsupported or missing"
            continue
        res=run_shell(c["command"], wd, int(c.get("timeoutSeconds") or 600)); refs=write_cmd_evidence(md, f"{vid}-{c.get('name','check')}", res); ev += refs; ok=res["exitCode"] == 0
        cr.append({"name": c.get("name"), "kind":"command", "command": c["command"], "required": c.get("required", True), "status":"passed" if ok else "failed", "exitCode": res["exitCode"], "evidenceRefs": refs})
        if c.get("required", True) and not ok:
            result="environment_error" if res.get("timedOut") else "fail"; fc="environment_error" if res.get("timedOut") else "validation_failed"; summary=f"Required check failed: {c.get('name')}"
    if cs and attempt.get("status") == "succeeded" and all(x.get("status") == "passed" for x in cr if x.get("required", True)):
        result="pass"; fc=None; summary="All required validation checks passed."
    action = "continue" if result == "pass" else "fix_first" if result == "fail" else "escalate" if result in ["requires_human", "environment_error"] else "collect_evidence"
    v={"validationId": vid, "scope":"mission" if step.get("type")=="acceptance" else "step", "targetId": step.get("stepId"), "workerResultRef": attempt.get("attemptId"), "createdAt": now(), "result": result, "checks": cs, "checkResults": cr, "evidenceRefs": ev or attempt.get("artifactRefs", []), "validationSummary": summary, "summary": summary, "failureClass": fc, "reasoningSummary": summary, "recommendedAction": action, "canRetrySameStrategy": False}
    save(md/"evidence"/f"{vid}.json", v); append_jsonl(md/"validation_log.jsonl", v)
    vs=valstate(md); vs.setdefault("assertions", {})[step.get("stepId")]={"status": result, "validationId": vid, "updatedAt": now(), "summary": summary, "failureClass": fc, "evidenceRefs": v["evidenceRefs"]}
    if v["scope"] == "mission": vs.setdefault("mission", {})["acceptance"]={"status": result, "validationId": vid, "updatedAt": now(), "summary": summary}
    save(md/"validation-state.json", vs); return v


def next_step(fs: dict[str, Any]) -> dict[str, Any] | None:
    steps=fs.get("steps", [])
    def okdep(st: dict[str, Any]) -> bool:
        return all(next((x for x in steps if x.get("stepId")==d), {"status":"passed"}).get("status") == "passed" for d in (st.get("dependsOn") or []))
    for st in steps:
        if st.get("type") == "acceptance":
            continue
        if st.get("status", "pending") in ["pending", "failed", "needs_validation"] and okdep(st) and int(st.get("attemptCount",0)) < int(st.get("retryBudget",1)):
            return st
    return None


def all_core_passed(fs: dict[str, Any]) -> bool:
    core=[s for s in fs.get("steps", []) if s.get("type") != "acceptance"]
    return bool(core) and all(s.get("status") in ["passed", "skipped"] for s in core)


def run_mission(md: Path, max_steps: int=10, resume: bool=False, stale: bool=False) -> dict[str, Any]:
    layout(md); msg=acquire(md, stale)
    if msg:
        return {"ok": False, "status":"locked", "message": msg}
    ran=[]
    try:
        s=state(md)
        if resume:
            (md/"pause.requested").unlink(missing_ok=True); s["pauseRequested"]=False; event(md,"mission_resumed", resumeWorkerSessionId=s.get("latestAttemptId"), resumeFrom=s.get("resumeFrom"))
        event(md,"mission_run_started", message="Starting or continuing mission execution", resume=resume); s.update({"state":"active", "status":"active", "phase":"executing"}); save(md/"state.json", s)
        for _ in range(max_steps):
            s=state(md); fs=features(md)
            if (md/"pause.requested").exists() or s.get("pauseRequested"):
                event(md,"worker_paused", stepId=s.get("currentStepId"), attemptId=s.get("latestAttemptId")); s.update({"pauseRequested":False,"state":"paused","status":"paused","phase":"paused","resumeFrom":s.get("currentStepId")}); save(md/"state.json",s); event(md,"mission_paused", resumeFrom=s.get("resumeFrom")); return {"ok": True, "status":"paused", "ranSteps":ran}
            st=next_step(fs)
            if not st:
                if all_core_passed(fs):
                    s.update({"state":"ready","status":"active","phase":"ready_for_acceptance","resumeFrom":"accept"}); save(md/"state.json",s); event(md,"mission_ready_for_acceptance"); return {"ok": True, "status":"ready_for_acceptance", "ranSteps":ran}
                s.update({"state":"blocked","status":"blocked","phase":"blocked"}); save(md/"state.json",s); return {"ok": False, "status":"blocked", "message":"No runnable step found", "ranSteps":ran}
            st["status"]="in_progress"; st.setdefault("startedAt", now()); s.update({"currentStepId":st.get("stepId"), "resumeFrom":st.get("stepId"), "phase":"executing"}); save(md/"state.json",s); save(md/"features.json",fs); event(md,"worker_selected_feature", stepId=st.get("stepId"), title=st.get("title"), type=st.get("type")); event(md,"worker_started", stepId=st.get("stepId"))
            att=execute_worker(md,st,s); h=handoff(md,att,st); s["latestAttemptId"]=att["attemptId"]; s["lastReviewedHandoffCount"]=len(list((md/"handoffs").glob("*.json"))); save(md/"state.json",s)
            if att["status"] == "paused":
                event(md,"worker_paused", stepId=st.get("stepId"), attemptId=att["attemptId"])
                st["status"]="pending"; save(md/"features.json",fs)
                s.update({"pauseRequested":False,"state":"paused","status":"paused","phase":"paused","resumeFrom":st.get("stepId")}); save(md/"state.json",s); event(md,"mission_paused", resumeFrom=s.get("resumeFrom")); return {"ok": True, "status":"paused", "ranSteps":ran}
            st["attemptCount"]=int(st.get("attemptCount",0))+1
            if att["status"] != "succeeded":
                event(md,"worker_failed", stepId=st.get("stepId"), attemptId=att["attemptId"], reason=att.get("failureClass"), detail=att.get("failureDetail")); st.update({"status":"failed", "failureClass":att.get("failureClass"), "failureDetail":att.get("failureDetail")}); save(md/"features.json",fs)
                if st["attemptCount"] >= int(st.get("retryBudget",1)):
                    s.update({"state":"escalated","status":"waiting_human","phase":"escalated","latestEscalationReason":"retry_exhausted"}); save(md/"state.json",s); event(md,"mission_escalated", stepId=st.get("stepId"), reason="retry_exhausted"); return {"ok":False,"status":"escalated","ranSteps":ran}
                event(md,"fix_first_queue_reordered", message="Reordered the queue after worker failure. Continue mission execution with fix-first sequencing.", stepId=st.get("stepId")); ran.append({"stepId":st.get("stepId"),"workerStatus":att["status"]}); continue
            event(md,"worker_completed", stepId=st.get("stepId"), attemptId=att["attemptId"], handoffId=h["handoffId"]); st["status"]="needs_validation"; save(md/"features.json",fs); event(md,"milestone_validation_triggered", stepId=st.get("stepId"), attemptId=att["attemptId"]); s["phase"]="validating"; save(md/"state.json",s)
            v=validate(md,st,att,s); s["latestValidationId"]=v["validationId"]; s["phase"]="executing"; save(md/"state.json",s); event(md,"validator_completed", stepId=st.get("stepId"), validationId=v["validationId"], result=v["result"], recommendedAction=v["recommendedAction"])
            if v["result"] == "pass":
                st.update({"status":"passed", "failureClass":None, "failureDetail":None, "passedAt":now()}); save(md/"features.json",fs); ran.append({"stepId":st.get("stepId"),"attemptId":att["attemptId"],"workerStatus":att["status"],"validation":"pass"}); continue
            st.update({"status":"failed", "failureClass":v.get("failureClass"), "failureDetail":v.get("summary"), "requiredStrategyChange":v.get("recommendedAction")}); save(md/"features.json",fs)
            if v["recommendedAction"] == "fix_first" and st["attemptCount"] < int(st.get("retryBudget",1)):
                event(md,"fix_first_queue_reordered", message="Reordered the queue after validation failure. Continue mission execution with fix-first sequencing.", stepId=st.get("stepId")); ran.append({"stepId":st.get("stepId"),"attemptId":att["attemptId"],"workerStatus":att["status"],"validation":v["result"]}); continue
            s.update({"state":"escalated","status":"waiting_human","phase":"escalated","latestEscalationReason":v["result"]}); save(md/"state.json",s); event(md,"mission_escalated", stepId=st.get("stepId"), reason=v["result"]); return {"ok":False,"status":"escalated","ranSteps":ran}
        return {"ok": True, "status":"max_steps_reached", "ranSteps":ran}
    finally:
        release(md)


def accept_mission(md: Path) -> dict[str, Any]:
    s=state(md); fs=features(md); st=next((x for x in fs.get("steps",[]) if x.get("type")=="acceptance"), None) or {"stepId":"acceptance","title":"Mission acceptance","type":"acceptance","status":"pending","attemptCount":0,"retryBudget":1,"checks":(s.get("acceptancePolicy") or {}).get("checks") or []}
    if st not in fs.get("steps",[]):
        fs.setdefault("steps",[]).append(st)
    att={"attemptId":mid("acceptance"),"stepId":st["stepId"],"status":"succeeded","artifactRefs":[],"outputSummary":"Acceptance validation requested","failureClass":None}
    event(md,"milestone_validation_triggered", stepId=st["stepId"], attemptId=att["attemptId"], acceptance=True); v=validate(md,st,att,s); s.update({"latestValidationId":v["validationId"], "state":"accepted" if v["result"]=="pass" else "blocked", "status":"accepted" if v["result"]=="pass" else "blocked", "phase":"accepted" if v["result"]=="pass" else "accepting", "resumeFrom":None if v["result"]=="pass" else "accept"}); save(md/"state.json",s); st["status"]="passed" if v["result"]=="pass" else "failed"; st["attemptCount"]=int(st.get("attemptCount",0))+1; save(md/"features.json",fs); event(md,"acceptance_completed", validationId=v["validationId"], result=v["result"]); return {"ok":v["result"]=="pass", "status":s["status"], "validation":v}


def cmd_init(a) -> int:
    ensure(home()); mid_ = a.mission_id or mid("mission"); md=home()/mid_
    if md.exists() and not a.force:
        print(f"Mission exists: {md}", file=sys.stderr); return 2
    layout(md); wd=Path(a.workspace).expanduser().resolve(); ensure(wd)
    checks=[{"name":f"acceptance-{i+1}","kind":"command","command":c,"required":True} for i,c in enumerate(a.accept or [])]
    constraints=a.constraint or []
    (md/"mission.md").write_text(f"# {a.name}\n\n## Goal\n{a.goal}\n\n## Workspace\n{wd}\n\n## Constraints\n" + "\n".join([f"- {c}" for c in constraints] or ["- none declared"]) + "\n\n## Acceptance Checks\n" + "\n".join([f"- `{c['command']}`" for c in checks] or ["- none declared"]) + "\n", encoding="utf-8")
    (md/"working_directory.txt").write_text(str(wd), encoding="utf-8")
    s={"version":1,"missionId":mid_,"name":a.name,"goal":a.goal,"constraints":constraints,"state":"initialized","phase":"planning","status":"active","workingDirectory":str(wd),"workspacePath":str(wd),"currentStepId":None,"defaultAdapterRef":a.adapter_id,"acceptancePolicy":{"checks":checks},"latestAttemptId":None,"latestValidationId":None,"lastReviewedHandoffCount":0,"resumeFrom":"run","pauseRequested":False,"createdAt":now(),"updatedAt":now()}; save(md/"state.json",s)
    if a.worker_command:
        step={"stepId":"step-worker","title":"Run external CLI worker","objective":a.goal,"type":"external_cli","commandTemplate":a.worker_command,"status":"pending","owner":"worker","attemptCount":0,"retryBudget":a.retry_budget,"checks":[{"name":f"validate-{i+1}","kind":"command","command":c,"required":True} for i,c in enumerate(a.validate or [])]}
    elif a.step_command:
        step={"stepId":"step-shell","title":a.step_title or "Run shell worker command","objective":a.goal,"type":"shell","command":a.step_command,"status":"pending","owner":"worker","attemptCount":0,"retryBudget":a.retry_budget,"checks":[{"name":f"validate-{i+1}","kind":"command","command":c,"required":True} for i,c in enumerate(a.validate or [])]}
    else:
        default_type = "model_plan" if a.plan_only and a.adapter_id else "llm_worker" if a.adapter_id else "noop"
        step={"stepId":"step-worker","title":"Run LLM JSON worker" if default_type == "llm_worker" else "Create execution plan / handoff","objective":a.goal,"type":default_type,"adapterRef":a.adapter_id,"status":"pending","owner":"worker","attemptCount":0,"retryBudget":a.retry_budget,"checks":[{"name":f"validate-{i+1}","kind":"command","command":c,"required":True} for i,c in enumerate(a.validate or [])],"allowModelCommands":bool(a.allow_model_commands)}
    steps=[step]
    if checks:
        steps.append({"stepId":"step-acceptance","title":"Mission acceptance checks","objective":"Run final acceptance checks","type":"acceptance","status":"pending","owner":"validator","attemptCount":0,"retryBudget":1,"dependsOn":[step["stepId"]],"checks":checks})
    save(md/"features.json", {"version":1,"missionId":mid_,"steps":steps,"createdAt":now(),"updatedAt":now()})
    save(md/"validation-state.json", {"version":1,"missionId":mid_,"assertions":{x["stepId"]:{"status":"pending","updatedAt":now()} for x in steps},"mission":{"acceptance":{"status":"pending"}},"updatedAt":now()})
    save(md/"model-settings.json", {"version":1,"workerModel":a.adapter_id,"workerReasoningEffort":a.reasoning_effort,"defaultAdapterRef":a.adapter_id,"roleAssignments":{"orchestrator":a.adapter_id,"worker":a.adapter_id,"validator":a.adapter_id} if a.adapter_id else {},"updatedAt":now()})
    save(md/"runtime-custom-models.json", {"version":1,"customModels":[]})
    if a.adapter_id:
        save_adapter(md, {"id":a.adapter_id,"adapterId":a.adapter_id,"provider":a.provider_type,"providerType":a.provider_type,"model":a.model,"modelName":a.model,"displayName":a.adapter_label or a.adapter_id,"baseUrl":a.base_url,"apiKeyEnvVar":a.api_key_env,"noImageSupport":True,"timeoutMs":a.timeout_ms,"retryPolicy":{"maxRetries":a.adapter_retries,"backoffMs":a.adapter_backoff_ms},"fallbackAdapterIds":[],"capabilityFlags":a.capability or [],"enabled":True,"notes":a.adapter_notes})
    event(md,"mission_initialized", missionId=mid_, workingDirectory=str(wd), steps=len(steps))
    out={"ok":True,"missionId":mid_,"missionDir":str(md)}
    if a.json: print(json.dumps(out,indent=2,ensure_ascii=False))
    else: print(f"Created mission {mid_}\nMission dir: {md}\nWorkspace:   {wd}\nNext:        mission run {mid_}")
    return 0


def status_obj(md: Path) -> dict[str, Any]:
    s=state(md); fs=features(md); vs=valstate(md); cur=next((x for x in fs.get("steps",[]) if x.get("stepId")==s.get("currentStepId")), None)
    return redact({"missionDir":str(md),"missionId":s.get("missionId"),"name":s.get("name"),"state":s.get("state"),"phase":s.get("phase"),"status":s.get("status"),"workingDirectory":s.get("workingDirectory"),"currentStep":cur,"latestAttemptId":s.get("latestAttemptId"),"latestValidationId":s.get("latestValidationId"),"lastReviewedHandoffCount":s.get("lastReviewedHandoffCount"),"resumeFrom":s.get("resumeFrom"),"steps":[{k:x.get(k) for k in ["stepId","title","type","status","attemptCount","retryBudget","failureClass","failureDetail"]} for x in fs.get("steps",[])],"validationState":vs,"locked":(md/"run.lock").exists(),"pauseRequested":(md/"pause.requested").exists() or s.get("pauseRequested")})


def cmd_run(a):
    r=run_mission(resolve(a.mission), a.max_steps, a.resume, a.allow_stale_lock)
    print(json.dumps(r,indent=2,ensure_ascii=False) if a.json else f"run status: {r.get('status')}" + ''.join([f"\n- {x.get('stepId')}: worker={x.get('workerStatus')} validation={x.get('validation')}" for x in r.get('ranSteps',[])]))
    return 0 if r.get("ok") else 1


def cmd_status(a):
    o=status_obj(resolve(a.mission))
    if a.json: print(json.dumps(o,indent=2,ensure_ascii=False))
    else:
        print(f"Mission: {o.get('missionId')} — {o.get('name')}\nDir:     {o.get('missionDir')}\nState:   {o.get('state')} / {o.get('phase')} / {o.get('status')}\nCurrent: {o.get('resumeFrom')} latestAttempt={o.get('latestAttemptId')} latestValidation={o.get('latestValidationId')}\nLocked:  {o.get('locked')} pauseRequested={o.get('pauseRequested')}\nSteps:")
        for s in o.get("steps",[]): print(f"- {s.get('stepId'):<18} {s.get('status'):<16} attempts={s.get('attemptCount')}/{s.get('retryBudget')} {s.get('title')}")
    return 0


def cmd_pause(a):
    md=resolve(a.mission); s=state(md); s.update({"pauseRequested":True,"state":"pause_requested","status":"pause_requested","resumeFrom":s.get("currentStepId")}); save(md/"state.json",s); (md/"pause.requested").write_text(now(),encoding="utf-8"); event(md,"mission_pause_requested", resumeFrom=s.get("resumeFrom")); print(json.dumps({"ok":True,"status":"pause_requested","resumeFrom":s.get("resumeFrom")},indent=2) if a.json else f"pause requested: {s.get('resumeFrom')}"); return 0


def cmd_resume(a):
    md=resolve(a.mission); (md/"pause.requested").unlink(missing_ok=True); s=state(md); s.update({"pauseRequested":False,"state":"active","status":"active","phase":"executing"}); save(md/"state.json",s); event(md,"mission_resumed", resumeWorkerSessionId=s.get("latestAttemptId"), resumeFrom=s.get("resumeFrom")); r=run_mission(md,a.max_steps,True,True) if a.run else {"ok":True,"status":"resumed","resumeFrom":s.get("resumeFrom")}; print(json.dumps(r,indent=2,ensure_ascii=False) if a.json else f"resumed: {r.get('status')} resumeFrom={r.get('resumeFrom')}"); return 0 if r.get("ok") else 1


def cmd_restart(a):
    md=resolve(a.mission); release(md); (md/"pause.requested").unlink(missing_ok=True); s=state(md); s.update({"pauseRequested":False,"state":"active","status":"active","phase":"executing"}); save(md/"state.json",s); fs=features(md); cur=next((x for x in fs.get("steps",[]) if x.get("stepId")==s.get("currentStepId")),None)
    if cur and cur.get("status")=="in_progress": cur["status"]="failed"; cur["failureClass"]="orphan_cleanup"; save(md/"features.json",fs)
    event(md,"worker_failed", stepId=s.get("currentStepId"), attemptId=s.get("latestAttemptId"), reason="orphan_cleanup"); event(md,"mission_run_started", message="Restarting mission from scratch", restart=True); r=run_mission(md,a.max_steps,False,True) if a.run else {"ok":True,"status":"restarted","resumeFrom":s.get("resumeFrom")}; print(json.dumps(r,indent=2,ensure_ascii=False) if a.json else f"restart: {r.get('status')} resumeFrom={r.get('resumeFrom')}"); return 0 if r.get("ok") else 1


def cmd_accept(a):
    r=accept_mission(resolve(a.mission))
    if a.json: print(json.dumps(r,indent=2,ensure_ascii=False))
    else:
        v=r.get("validation",{}); print(f"accept status: {r.get('status')}\nvalidation: {v.get('result')} — {v.get('summary')}"); [print(f"- {c.get('name')}: {c.get('status')} exit={c.get('exitCode')}") for c in v.get("checkResults",[])]
    return 0 if r.get("ok") else 1


def cmd_abort(a):
    md=resolve(a.mission); s=state(md); s.update({"state":"aborted","status":"aborted","phase":"aborted","abortReason":a.reason or "user_requested"}); save(md/"state.json",s); release(md); (md/"pause.requested").unlink(missing_ok=True); event(md,"mission_aborted", reason=s["abortReason"]); print(json.dumps({"ok":True,"status":"aborted"},indent=2) if a.json else "mission aborted"); return 0


def cmd_export(a):
    md=resolve(a.mission); out=Path(a.output).expanduser() if a.output else md.with_suffix(".tar.gz")
    with tarfile.open(out,"w:gz") as tar:
        for p in md.rglob("*"):
            if p.name != "run.lock": tar.add(p, arcname=str(p.relative_to(md.parent)), recursive=False)
    event(md,"mission_exported", outputPath=str(out)); print(json.dumps({"ok":True,"path":str(out)},indent=2) if a.json else f"exported: {out}"); return 0


def cmd_step_add(a):
    md=resolve(a.mission); fs=features(md); sid=a.step_id or f"step-{len(fs.get('steps',[]))+1:03d}"; st={"stepId":sid,"title":a.title,"objective":a.objective or a.title,"type":a.type,"status":"pending","owner":a.owner,"attemptCount":0,"retryBudget":a.retry_budget,"dependsOn":a.depends_on or [],"checks":[{"name":f"validate-{i+1}","kind":"command","command":c,"required":True} for i,c in enumerate(a.validate or [])]}
    if a.command: st["command"]=a.command
    if a.command_template: st["commandTemplate"]=a.command_template
    if a.adapter_ref: st["adapterRef"]=a.adapter_ref
    if a.allow_model_commands: st["allowModelCommands"]=True
    fs.setdefault("steps",[]).append(st); save(md/"features.json",fs); vs=valstate(md); vs.setdefault("assertions",{})[sid]={"status":"pending","updatedAt":now()}; save(md/"validation-state.json",vs); print(json.dumps({"ok":True,"step":st},indent=2,ensure_ascii=False) if a.json else f"added step: {sid}"); return 0


def cmd_adapters_add(a):
    if getattr(a,"api_key",None): print("Refusing to store raw API key. Use --api-key-env.", file=sys.stderr); return 2
    md=resolve(a.mission); ad={"id":a.adapter_id,"adapterId":a.adapter_id,"provider":a.provider_type,"providerType":a.provider_type,"model":a.model,"modelName":a.model,"displayName":a.label or a.adapter_id,"baseUrl":a.base_url,"apiKeyEnvVar":a.api_key_env,"noImageSupport":True,"maxOutputTokens":a.max_output_tokens,"timeoutMs":a.timeout_ms,"retryPolicy":{"maxRetries":a.retries,"backoffMs":a.backoff_ms},"fallbackAdapterIds":a.fallback or [],"capabilityFlags":a.capability or [],"enabled":not a.disabled,"notes":a.notes}
    if a.command: ad["command"]=a.command
    save_adapter(md,ad); ms=load(md/"model-settings.json",{}); ms.setdefault("roleAssignments",{})
    for role in a.role or []:
        ms["roleAssignments"][role]=a.adapter_id
        if role=="worker": ms["workerModel"]=a.adapter_id
    save(md/"model-settings.json",ms); print(json.dumps({"ok":True,"adapter":ad},indent=2,ensure_ascii=False) if a.json else f"adapter saved: {a.adapter_id}"); return 0


def cmd_adapters_list(a):
    ads=registry(resolve(a.mission)).get("customModels",[]); print(json.dumps({"adapters":ads},indent=2,ensure_ascii=False) if a.json else "\n".join([f"- {x.get('id'):<24} {x.get('providerType') or x.get('provider'):<22} model={x.get('modelName') or x.get('model')} env={x.get('apiKeyEnvVar') or '-'} enabled={x.get('enabled', True)}" for x in ads])); return 0


def cmd_adapters_test(a):
    md=resolve(a.mission)
    try:
        r=call_adapter(md,a.adapter_id,a.prompt,"smoke_test"); out={"ok":True,"adapterId":a.adapter_id,"providerType":r.get("providerType"),"model":r.get("model"),"contentPreview":short(r.get("content",""),300),"durationMs":r.get("durationMs")}
    except Exception as e:
        out={"ok":False,"adapterId":a.adapter_id,"error":error_category(e),"message":short(str(e),800)}
    print(json.dumps(out,indent=2,ensure_ascii=False) if a.json else (f"adapter ok: {out.get('adapterId')} model={out.get('model')} duration={out.get('durationMs')}ms\n{out.get('contentPreview')}" if out.get("ok") else f"adapter failed: {out.get('error')} {out.get('message')}")); return 0 if out.get("ok") else 1


def build() -> argparse.ArgumentParser:
    p=argparse.ArgumentParser(prog="mission"); p.add_argument("--version", action="version", version=f"mission {VERSION}"); sub=p.add_subparsers(dest="command", required=True)
    init=sub.add_parser("init"); init.set_defaults(func=cmd_init); init.add_argument("--mission-id"); init.add_argument("--name",required=True); init.add_argument("--goal",required=True); init.add_argument("--workspace",default="."); init.add_argument("--constraint",action="append"); init.add_argument("--accept",action="append"); init.add_argument("--validate",action="append"); init.add_argument("--worker-command"); init.add_argument("--step-command"); init.add_argument("--step-title"); init.add_argument("--retry-budget",type=int,default=2); init.add_argument("--force",action="store_true"); init.add_argument("--json",action="store_true"); init.add_argument("--adapter-id"); init.add_argument("--adapter-label"); init.add_argument("--provider-type",default="openai_compatible",choices=["openai_compatible","anthropic_compatible","custom_gateway","cli_command","external_cli"]); init.add_argument("--base-url"); init.add_argument("--api-key-env"); init.add_argument("--model"); init.add_argument("--timeout-ms",type=int,default=30000); init.add_argument("--adapter-retries",type=int,default=1); init.add_argument("--adapter-backoff-ms",type=int,default=500); init.add_argument("--capability",action="append"); init.add_argument("--adapter-notes"); init.add_argument("--reasoning-effort",default="medium"); init.add_argument("--allow-model-commands",action="store_true"); init.add_argument("--plan-only",action="store_true",help="Use model as plan-only worker instead of JSON delta worker")
    for name,func in [("run",cmd_run),("status",cmd_status),("pause",cmd_pause),("resume",cmd_resume),("restart",cmd_restart),("accept",cmd_accept),("abort",cmd_abort),("export",cmd_export)]:
        sp=sub.add_parser(name); sp.set_defaults(func=func); sp.add_argument("mission",nargs="?"); sp.add_argument("--json",action="store_true")
        if name=="run": sp.add_argument("--max-steps",type=int,default=10); sp.add_argument("--resume",action="store_true"); sp.add_argument("--allow-stale-lock",action="store_true")
        if name in ["resume","restart"]: sp.add_argument("--run",action="store_true"); sp.add_argument("--max-steps",type=int,default=10)
        if name=="abort": sp.add_argument("--reason")
        if name=="export": sp.add_argument("--output")
    step=sub.add_parser("step"); ss=step.add_subparsers(dest="step_command",required=True); add=ss.add_parser("add"); add.set_defaults(func=cmd_step_add); add.add_argument("mission"); add.add_argument("--step-id"); add.add_argument("--title",required=True); add.add_argument("--objective"); add.add_argument("--type",default="llm_worker",choices=["shell","external_cli","model_plan","llm_worker","model_patch","model","noop","acceptance"]); add.add_argument("--owner",default="worker"); add.add_argument("--command"); add.add_argument("--command-template"); add.add_argument("--adapter-ref"); add.add_argument("--validate",action="append"); add.add_argument("--depends-on",action="append"); add.add_argument("--retry-budget",type=int,default=2); add.add_argument("--allow-model-commands",action="store_true"); add.add_argument("--json",action="store_true")
    ad=sub.add_parser("adapters"); aa=ad.add_subparsers(dest="adapter_command",required=True); add=aa.add_parser("add"); add.set_defaults(func=cmd_adapters_add); add.add_argument("mission"); add.add_argument("--adapter-id",required=True); add.add_argument("--label"); add.add_argument("--provider-type",required=True,choices=["openai_compatible","anthropic_compatible","custom_gateway","cli_command","external_cli"]); add.add_argument("--base-url"); add.add_argument("--api-key-env"); add.add_argument("--api-key",help=argparse.SUPPRESS); add.add_argument("--model"); add.add_argument("--command"); add.add_argument("--timeout-ms",type=int,default=30000); add.add_argument("--retries",type=int,default=1); add.add_argument("--backoff-ms",type=int,default=500); add.add_argument("--fallback",action="append"); add.add_argument("--capability",action="append"); add.add_argument("--max-output-tokens",type=int); add.add_argument("--disabled",action="store_true"); add.add_argument("--notes"); add.add_argument("--role",action="append",choices=["orchestrator","worker","validator"]); add.add_argument("--json",action="store_true")
    ls=aa.add_parser("list"); ls.set_defaults(func=cmd_adapters_list); ls.add_argument("mission"); ls.add_argument("--json",action="store_true")
    tst=aa.add_parser("test"); tst.set_defaults(func=cmd_adapters_test); tst.add_argument("mission"); tst.add_argument("adapter_id"); tst.add_argument("--prompt",default="Reply with OK and one short sentence."); tst.add_argument("--json",action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    try:
        a=build().parse_args(argv); return int(a.func(a) or 0)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr); return 2
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr); return 130


if __name__ == "__main__":
    raise SystemExit(main())
