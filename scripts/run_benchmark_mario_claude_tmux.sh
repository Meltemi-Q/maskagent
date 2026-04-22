#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GOAL_FILE="${ROOT_DIR}/scripts/benchmarks/mario-full-goal.txt"
WORKER_SCRIPT="${ROOT_DIR}/scripts/claude_tmux_worker.sh"
npm --prefix "${ROOT_DIR}" run build >/dev/null
CLI=(node "${ROOT_DIR}/dist/cli.js")
BROWSER_CHECK=(node "${ROOT_DIR}/dist/browser-platformer-check.js")

BENCH_HOME="${MASKAGENT_CLAUDE_BENCH_HOME:-${MASKAGENT_BENCH_HOME:-/tmp/maskagent-bench-claude-missions}}"
BENCH_WORKSPACE="${MASKAGENT_CLAUDE_BENCH_WORKSPACE:-${MASKAGENT_BENCH_WORKSPACE:-/tmp/maskagent-bench-claude-workspace}}"
BENCH_MISSION_ID="${MASKAGENT_CLAUDE_BENCH_MISSION_ID:-${MASKAGENT_BENCH_MISSION_ID:-bench-mario-claude}}"
: "${MASKAGENT_CLAUDE_TIMEOUT_S:=3600}"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude is required for this benchmark" >&2
  exit 127
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for this benchmark" >&2
  exit 127
fi

export MASKAGENT_HOME="${BENCH_HOME}"
export MASKAGENT_CLAUDE_TIMEOUT_S
rm -rf "${MASKAGENT_HOME:?}/${BENCH_MISSION_ID}"
rm -rf "${BENCH_WORKSPACE}"
mkdir -p "${BENCH_WORKSPACE}"

GOAL="$(cat "${GOAL_FILE}")"
START_TS="$(date +%s)"

"${CLI[@]}" init \
  --mission-id "${BENCH_MISSION_ID}" \
  --force \
  --name "benchmark-mario-claude-tmux" \
  --goal "${GOAL}" \
  --workspace "${BENCH_WORKSPACE}" \
  --worker-command "bash ${WORKER_SCRIPT} {workspace} {prompt_file} {mission_dir}" \
  --validate 'test -f index.html' \
  --validate 'test -f game-core.mjs' \
  --validate 'test -f game-browser.mjs' \
  --validate 'test -f smoke-test.mjs' \
  --validate 'node smoke-test.mjs' \
  --accept 'node smoke-test.mjs' \
  --accept 'grep -q LEVELS game-core.mjs' \
  --accept "grep -Eiq 'platformer|mario' index.html"

"${CLI[@]}" run "${BENCH_MISSION_ID}" --max-steps 3
"${CLI[@]}" accept "${BENCH_MISSION_ID}"

MISSION_DIR="${MASKAGENT_HOME}/${BENCH_MISSION_ID}"
"${BROWSER_CHECK[@]}" \
  "${BENCH_WORKSPACE}" \
  --output-dir "${MISSION_DIR}/browser-check"

END_TS="$(date +%s)"
echo "elapsed_seconds=$((END_TS - START_TS))"
"${CLI[@]}" status "${BENCH_MISSION_ID}" --json
