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
src/cli.ts                         TypeScript CLI entrypoint
src/runtime.ts                     TypeScript runtime and state machine
src/browser-platformer-check.ts    Browser-level validation script
tests/runtime.test.mjs             Node test coverage
scripts/live-openai-compatible-smoke.sh
scripts/live-minimax-anthropic-smoke.sh
scripts/claude_tmux_worker.sh
scripts/live-claude-tmux-smoke.sh
scripts/run_benchmark_mario_byok.sh
scripts/run_benchmark_mario_claude_tmux.sh
scripts/run_benchmark_mario_all.sh
VALIDATION.md                       Validation notes and live test results
```

## Install

Install dependencies and build:

```bash
cd maskagent
npm install
npm run build
node dist/cli.js --version
```

Global npm install:

```bash
cd maskagent
npm install -g . --force
mission --version
maskagent --version
```

Interactive guide:

```bash
mission
mission guide
```

Run from source:

```bash
cd maskagent
node dist/cli.js --help
```

Notes:

- The runtime now lives in TypeScript / Node.
- `npm install -g . --force` is the preferred install path. Use `--force` if an older Python-installed `mission` binary already exists on PATH.
- If your goal is simply "run the CLI inside the repo", `npm install && npm run build` plus `node dist/cli.js` is enough.
- In an interactive terminal, running `mission` or `maskagent` with no arguments opens the guide. In non-interactive environments it falls back to `--help`.

## Test

```bash
npm test
```

## Quick Start

Deterministic shell worker:

```bash
export MASKAGENT_HOME=/tmp/missions
mkdir -p /tmp/demo-workspace

node dist/cli.js init \
  --name "write marker" \
  --goal "Create a marker file and prove it exists" \
  --workspace /tmp/demo-workspace \
  --step-command "printf ok > marker.txt" \
  --validate "test -f marker.txt" \
  --accept "grep -q ok marker.txt"

node dist/cli.js run --max-steps 5
node dist/cli.js accept
node dist/cli.js status
```

If you do not want to write flags by hand, run `mission` and follow the guide to:

- create a mission
- choose a BYOK, Claude tmux, or shell worker
- optionally run it immediately
- optionally continue into acceptance

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

## Fixed Regression Benchmark

The Mario benchmark is now scripted into the repository so it can be rerun with one command instead of a manual sequence.

```bash
# BYOK llm_worker benchmark
export GPT_PROXY_API_KEY="..."
bash scripts/run_benchmark_mario_byok.sh

# Claude Code + tmux benchmark
bash scripts/run_benchmark_mario_claude_tmux.sh

# Run both
export GPT_PROXY_API_KEY="..."
bash scripts/run_benchmark_mario_all.sh
```

All benchmark scripts use the same prompt in `scripts/benchmarks/mario-full-goal.txt` and run:

- mission init
- mission run
- mission accept
- browser-level validation

You can override generic benchmark env vars such as `MASKAGENT_BENCH_HOME`, `MASKAGENT_BENCH_WORKSPACE`, and `MASKAGENT_BENCH_MISSION_ID`, or use runner-specific prefixes:

- `MASKAGENT_BYOK_BENCH_*`
- `MASKAGENT_CLAUDE_BENCH_*`

## Browser-Level Validation

Browser-level validation means opening the built game in a real browser, not only running `node smoke-test.mjs`.

`src/browser-platformer-check.ts` compiles to `dist/browser-platformer-check.js`. It starts a temporary static server, opens the app in headless Chrome or Edge, captures a screenshot, dumps the rendered DOM, and checks for core UI markers such as `canvas`, `platformer`, `move`, and `jump`.

Run it directly:

```bash
node dist/browser-platformer-check.js /path/to/workspace
```

Artifacts are written to `browser-check/` under the mission directory:

- `browser-check.png`
- `browser-check.dom.html`
- `browser-check.summary.json`

## Security Notes

- Do not store raw API keys in mission files.
- Use `--api-key-env NAME` and set `NAME` in the process environment.
- `mission adapters add --api-key ...` is refused.
- Logs redact common token patterns.
- LLM file writes are constrained to the workspace and reject absolute paths, `..`, and `.git` paths.
