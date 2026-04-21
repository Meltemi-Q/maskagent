#!/usr/bin/env bash
set -euo pipefail

: "${MASKAGENT_HOME:=/tmp/maskagent-claude-tmux-missions}"
: "${MASKAGENT_LIVE_WORKSPACE:=/tmp/maskagent-claude-tmux-workspace}"
: "${MASKAGENT_CLAUDE_TIMEOUT_S:=1800}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_SCRIPT="${ROOT_DIR}/scripts/claude_tmux_worker.sh"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude is required for live-claude-tmux-smoke.sh" >&2
  exit 127
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for live-claude-tmux-smoke.sh" >&2
  exit 127
fi

export MASKAGENT_HOME MASKAGENT_CLAUDE_TIMEOUT_S
rm -rf "${MASKAGENT_LIVE_WORKSPACE}"
mkdir -p "${MASKAGENT_LIVE_WORKSPACE}"

PYTHONPATH=src python3 -m mission_runtime.cli init \
  --name live-claude-tmux-smoke \
  --goal 'Create claude-worker.txt containing exactly hello from claude tmux worker' \
  --workspace "${MASKAGENT_LIVE_WORKSPACE}" \
  --worker-command "bash ${WORKER_SCRIPT} {workspace} {prompt_file} {mission_dir}" \
  --validate "grep -q 'hello from claude tmux worker' claude-worker.txt" \
  --accept 'test -f claude-worker.txt'

PYTHONPATH=src python3 -m mission_runtime.cli run --max-steps 3
PYTHONPATH=src python3 -m mission_runtime.cli accept
PYTHONPATH=src python3 -m mission_runtime.cli status
