# MaskAgent

[中文 README](README.zh-CN.md)

MaskAgent is a local mission orchestration CLI for software delivery tasks that need:

- multi-step agent handoffs
- persistent mission state under `~/.maskagent/missions/`
- worker -> validator -> acceptance loops
- pause/resume/restart
- BYOK model adapters
- external CLI workers such as Claude Code or Codex

It is not just a prompt wrapper. A mission is a durable state machine with attempts, evidence, handoffs, validation logs, and final acceptance checks.

## What It Does

- Stores missions at `~/.maskagent/missions/<mission-id>/` by default, or under `$MASKAGENT_HOME`.
- Persists `state.json`, `features.json`, `validation-state.json`, `model-settings.json`, `runtime-custom-models.json`.
- Appends attempts and evidence to `attempts.jsonl`, `progress_log.jsonl`, `worker-transcripts.jsonl`, `validation_log.jsonl`, `handoffs/`, `evidence/`.
- Supports three worker modes:
  - `llm_worker`: strict JSON file deltas returned by a model
  - `external_cli`: Claude Code, Codex, or any local agent CLI
  - `shell`: deterministic smoke tests and validators
- Separates worker success from final mission acceptance.
- Refuses to persist raw API keys. Mission config stores `apiKeyEnvVar` only.
- Supports pausing an active shell or external CLI worker and re-queueing the current step on resume.

## Repository Layout

```text
src/mission_runtime/cli.py          Main runtime and CLI entrypoint
tests/test_runtime.py               Unit coverage for mission flow
scripts/live-openai-compatible-smoke.sh
scripts/live-minimax-anthropic-smoke.sh
scripts/claude_tmux_worker.sh
scripts/live-claude-tmux-smoke.sh
VALIDATION.md                       Validation notes and live test results
```

## Install

Run from source:

```bash
cd maskagent
PYTHONPATH=src python3 -m mission_runtime.cli --version
```

Optional editable install:

```bash
python3 -m pip install -e .
mission --version
maskagent --version
```

## Test

```bash
PYTHONPATH=src PYTHONNOUSERSITE=1 python3 -S -m unittest discover -s tests -v
```

## Quick Start

Deterministic shell worker:

```bash
export MASKAGENT_HOME=/tmp/missions
mkdir -p /tmp/demo-workspace

PYTHONPATH=src python3 -m mission_runtime.cli init \
  --name "write marker" \
  --goal "Create a marker file and prove it exists" \
  --workspace /tmp/demo-workspace \
  --step-command "printf ok > marker.txt" \
  --validate "test -f marker.txt" \
  --accept "grep -q ok marker.txt"

PYTHONPATH=src python3 -m mission_runtime.cli run --max-steps 5
PYTHONPATH=src python3 -m mission_runtime.cli accept
PYTHONPATH=src python3 -m mission_runtime.cli status
```

## BYOK Model Adapters

OpenAI-compatible worker:

```bash
export GPT_PROXY_API_KEY="..."
bash scripts/live-openai-compatible-smoke.sh
```

Anthropic-compatible MiniMax worker:

```bash
export MINIMAX_API_KEY="..."
bash scripts/live-minimax-anthropic-smoke.sh
```

You can also wire adapters manually:

```bash
mission init \
  --name "adapter demo" \
  --goal "create a file via LLM JSON worker" \
  --workspace /tmp/demo-workspace \
  --adapter-id gpt-proxy-mini \
  --provider-type openai_compatible \
  --base-url "https://gpt.meltemi.fun/v1" \
  --api-key-env GPT_PROXY_API_KEY \
  --model gpt-5.4-mini

mission adapters test <mission-id> gpt-proxy-mini
```

## External CLI Workers

Claude Code through a tmux-monitored wrapper:

```bash
bash scripts/live-claude-tmux-smoke.sh
```

Direct command template examples:

```bash
mission init \
  --name "claude worker demo" \
  --goal "Implement feature X and run tests" \
  --workspace /path/to/repo \
  --worker-command "bash /abs/path/to/maskagent/scripts/claude_tmux_worker.sh {workspace} {prompt_file} {mission_dir}" \
  --accept "pytest -q"

mission init \
  --name "codex worker demo" \
  --goal "Fix failing tests" \
  --workspace /path/to/repo \
  --worker-command "codex exec --cd {workspace} --prompt-file {prompt_file}" \
  --accept "pytest -q"
```

Placeholders available inside `--worker-command`:

- `{prompt_file}`: shell-quoted prompt file path
- `{prompt}`: shell-quoted prompt text
- `{workspace}`: shell-quoted workspace path
- `{mission_dir}`: shell-quoted mission directory
- `{raw_prompt}`: unescaped prompt text

## Pause / Resume Behavior

- `mission pause` writes `pause.requested`.
- Active shell and external CLI workers notice that file, stop the current process tree, and record a paused attempt.
- The current step is moved back to `pending`.
- `mission resume --run` restarts execution from the paused step.
- `mission restart --run` marks an orphaned in-flight step as failed with `orphan_cleanup` and restarts mission execution.

## Challenge Prompts

Useful benchmark missions:

- Classic software: build a markdown editor, Kanban board, file uploader, or notes app with tests.
- Classic games: build Snake, 2048, Tetris, or a multi-level Mario-like platformer with collision, score, restart, and level progression.

Prompt template for a more ambitious Mario-like benchmark:

```text
Build a browser-playable side-scrolling platformer inspired by classic Super Mario.
Requirements:
- multiple levels with level selection and progression
- keyboard controls, gravity, collision, enemies, collectibles, score, lives
- restart from current level and full game reset
- mobile-friendly HUD
- no external paid assets; use placeholder art or CSS shapes
- include automated validation for build/test/lint and at least one gameplay smoke check
- keep the project self-contained in the workspace
Deliverable:
- passing validator checks
- short handoff summary of architecture, controls, and remaining risks
```

This kind of prompt is intentionally large enough to exercise planning, worker execution, validation, retries, and handoffs.

## Security Notes

- Do not store raw API keys in mission files.
- Use `--api-key-env NAME` and set `NAME` in the process environment.
- `mission adapters add --api-key ...` is refused.
- Logs redact common token patterns.
- LLM file writes are constrained to the workspace and reject absolute paths, `..`, and `.git` paths.
