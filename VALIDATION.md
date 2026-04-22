# Validation Report

Version: `0.4.0`

Validation date: `2026-04-22`

## What Was Validated

The product claim validated here is:

`LLM output -> runtime parses response -> workspace changes -> validator passes -> acceptance passes`

This was validated with live providers and with an external CLI worker, not only with fake HTTP test doubles.

## Local Validation

Environment:

- Host: local macOS workstation
- Runtime: local Node.js / TypeScript build
- Tools available: `tmux`, `claude`, `codex`, `git`

Automated tests:

```bash
npm test
```

Result:

`8` tests passed locally after the TypeScript rewrite.

Covered cases:

- default mission home is `~/.maskagent/missions`, not `.factory`
- mission layout and secret policy
- deterministic shell worker -> validator -> acceptance
- fake OpenAI / Anthropic adapter coverage
- live pause during a running step re-queues the current step and resumes cleanly
- pause / resume / restart / orphan cleanup events

Live provider validation on local machine:

1. `GPT Proxy` (`openai_compatible`)
   - `bash scripts/live-openai-compatible-smoke.sh`
   - Result: mission reached `accepted`
   - Workspace proof: `/tmp/maskagent-live-workspace/hello.txt`
   - File content: `hello from maskagent live llm`

2. `MiniMax` (`anthropic_compatible`)
   - `bash scripts/live-minimax-anthropic-smoke.sh`
   - Result: mission reached `accepted`
   - Workspace proof: `/tmp/maskagent-minimax-anthropic-workspace/hello.txt`
   - File content: `hello from minimax anthropic live llm`

3. `MiniMax` (`openai_compatible`) adapter smoke
   - `mission adapters test ... minimax-openai`
   - Result: adapter call succeeded locally after retry
   - Note: provider may intermittently return `529 overloaded`

External CLI validation on local machine:

1. Direct tmux wrapper check
   - `bash scripts/claude_tmux_worker.sh <workspace> <prompt_file>`
   - Result: created `direct-claude.txt`

2. Full mission through `Claude Code` via `tmux`
   - `bash scripts/live-claude-tmux-smoke.sh`
   - Result: mission reached `accepted`
   - Workspace proof: `/tmp/maskagent-claude-tmux-workspace/claude-worker.txt`
   - File content: `hello from claude tmux worker`

## VPS Validation

Environment:

- Host: `107.173.204.12`
- OS: Ubuntu 24.04 class environment
- Tools available: `git`, `tmux`, `claude`

Automated tests on VPS:

```bash
npm test
```

Result:

```text
Ran 7 tests in 6.129s
OK
```

Note:

- A portability issue surfaced on VPS first: `tests/` was not importable on Python 3.12 discovery in that environment.
- Fix applied: add `tests/__init__.py`.
- After the fix, the same test command passed both locally and on VPS.

Live provider validation on VPS:

1. `GPT Proxy` (`openai_compatible`)
   - `bash scripts/live-openai-compatible-smoke.sh`
   - Result: mission reached `accepted`
   - Workspace proof: `/tmp/maskagent-live-workspace/hello.txt`

VPS limitation:

- `claude -p` on the VPS returned `Not logged in · Please run /login`
- Therefore the `tmux + Claude Code` worker path was validated locally, not on VPS

## Secret Handling

Mission files were checked to confirm raw API keys were not persisted.

Observed persisted configuration:

```text
apiKeyEnvVar = GPT_PROXY_API_KEY
```

No raw `sk-...` values were written into mission state, evidence, or adapter registry files during validation.

## Product-Level Outcome

As of `2026-04-22`, the following are demonstrated working:

- persistent mission state rooted at `.maskagent`
- real live LLM JSON worker flow
- validator and acceptance gates
- external CLI worker flow
- `tmux`-monitored Claude Code wrapper
- pause/resume for active shell and external CLI workers
- local and VPS execution

The remaining environment-specific caveat is external CLI auth on machines where `claude` is installed but not logged in.
