#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
npm --prefix "${ROOT_DIR}" run build >/dev/null
CLI=(node "${ROOT_DIR}/dist/cli.js")

: "${MASKAGENT_HOME:=/tmp/maskagent-minimax-anthropic-missions}"
: "${MASKAGENT_LIVE_WORKSPACE:=/tmp/maskagent-minimax-anthropic-workspace}"
: "${MASKAGENT_LIVE_ADAPTER_ID:=minimax-anthropic}"
: "${MASKAGENT_LIVE_BASE_URL:=https://api.minimaxi.com/anthropic}"
: "${MASKAGENT_LIVE_MODEL:=MiniMax-M2.7}"
: "${MASKAGENT_LIVE_API_KEY_ENV:=MINIMAX_API_KEY}"

if [[ -z "${!MASKAGENT_LIVE_API_KEY_ENV:-}" ]]; then
  echo "Missing API key env var: ${MASKAGENT_LIVE_API_KEY_ENV}" >&2
  exit 2
fi

export MASKAGENT_HOME
rm -rf "${MASKAGENT_LIVE_WORKSPACE}"
mkdir -p "${MASKAGENT_LIVE_WORKSPACE}"

"${CLI[@]}" init \
  --name live-minimax-anthropic-smoke \
  --goal 'Create hello.txt containing exactly hello from minimax anthropic live llm' \
  --workspace "${MASKAGENT_LIVE_WORKSPACE}" \
  --adapter-id "${MASKAGENT_LIVE_ADAPTER_ID}" \
  --provider-type anthropic_compatible \
  --base-url "${MASKAGENT_LIVE_BASE_URL}" \
  --api-key-env "${MASKAGENT_LIVE_API_KEY_ENV}" \
  --model "${MASKAGENT_LIVE_MODEL}" \
  --adapter-retries 2 \
  --adapter-backoff-ms 1000 \
  --validate "grep -q 'hello from minimax anthropic live llm' hello.txt" \
  --accept 'test -f hello.txt'

"${CLI[@]}" run --max-steps 3
"${CLI[@]}" accept
"${CLI[@]}" status
