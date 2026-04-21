#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GOAL_FILE="${ROOT_DIR}/scripts/benchmarks/mario-full-goal.txt"

BENCH_HOME="${MASKAGENT_BYOK_BENCH_HOME:-${MASKAGENT_BENCH_HOME:-/tmp/maskagent-bench-byok-spark-full-missions}}"
BENCH_WORKSPACE="${MASKAGENT_BYOK_BENCH_WORKSPACE:-${MASKAGENT_BENCH_WORKSPACE:-/tmp/maskagent-bench-byok-spark-full-workspace}}"
BENCH_MISSION_ID="${MASKAGENT_BYOK_BENCH_MISSION_ID:-${MASKAGENT_BENCH_MISSION_ID:-bench-mario-byok-spark-full}}"
BENCH_MODEL="${MASKAGENT_BYOK_BENCH_MODEL:-${MASKAGENT_BENCH_MODEL:-gpt-5.3-codex-spark}}"
BENCH_BASE_URL="${MASKAGENT_BYOK_BENCH_BASE_URL:-${MASKAGENT_BENCH_BASE_URL:-https://gpt.meltemi.fun/v1}}"
BENCH_API_KEY_ENV="${MASKAGENT_BYOK_BENCH_API_KEY_ENV:-${MASKAGENT_BENCH_API_KEY_ENV:-GPT_PROXY_API_KEY}}"

if [[ -z "${!BENCH_API_KEY_ENV:-}" ]]; then
  echo "Missing API key env var: ${BENCH_API_KEY_ENV}" >&2
  exit 2
fi

export MASKAGENT_HOME="${BENCH_HOME}"
rm -rf "${MASKAGENT_HOME:?}/${BENCH_MISSION_ID}"
rm -rf "${BENCH_WORKSPACE}"
mkdir -p "${BENCH_WORKSPACE}"

GOAL="$(cat "${GOAL_FILE}")"
START_TS="$(date +%s)"

PYTHONPATH=src python3 -m mission_runtime.cli init \
  --mission-id "${BENCH_MISSION_ID}" \
  --force \
  --name "benchmark-mario-byok" \
  --goal "${GOAL}" \
  --workspace "${BENCH_WORKSPACE}" \
  --adapter-id benchmark-byok \
  --provider-type openai_compatible \
  --base-url "${BENCH_BASE_URL}" \
  --api-key-env "${BENCH_API_KEY_ENV}" \
  --model "${BENCH_MODEL}" \
  --timeout-ms 120000 \
  --adapter-retries 3 \
  --adapter-backoff-ms 1000 \
  --validate 'test -f index.html' \
  --validate 'test -f game-core.mjs' \
  --validate 'test -f game-browser.mjs' \
  --validate 'test -f smoke-test.mjs' \
  --validate 'node smoke-test.mjs' \
  --accept 'node smoke-test.mjs' \
  --accept 'grep -q LEVELS game-core.mjs' \
  --accept "grep -Eiq 'platformer|mario' index.html"

PYTHONPATH=src python3 -m mission_runtime.cli run "${BENCH_MISSION_ID}" --max-steps 3
PYTHONPATH=src python3 -m mission_runtime.cli accept "${BENCH_MISSION_ID}"

MISSION_DIR="${MASKAGENT_HOME}/${BENCH_MISSION_ID}"
python3 "${ROOT_DIR}/scripts/browser_platformer_check.py" \
  "${BENCH_WORKSPACE}" \
  --output-dir "${MISSION_DIR}/browser-check"

END_TS="$(date +%s)"
echo "elapsed_seconds=$((END_TS - START_TS))"
PYTHONPATH=src python3 -m mission_runtime.cli status "${BENCH_MISSION_ID}" --json
