#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
npm --prefix "${ROOT_DIR}" run build >/dev/null
CLI=(node "${ROOT_DIR}/dist/cli.js")

: "${MASKAGENT_HOME:=/tmp/maskagent-live-missions}"
: "${MASKAGENT_LIVE_WORKSPACE:=/tmp/maskagent-live-workspace}"
: "${MASKAGENT_LIVE_ADAPTER_ID:=gpt-proxy-mini}"
: "${MASKAGENT_LIVE_BASE_URL:=https://gpt.meltemi.fun/v1}"
: "${MASKAGENT_LIVE_MODEL:=gpt-5.4-mini}"
: "${MASKAGENT_LIVE_API_KEY_ENV:=GPT_PROXY_API_KEY}"

if [[ -z "${!MASKAGENT_LIVE_API_KEY_ENV:-}" ]]; then
  echo "Missing API key env var: ${MASKAGENT_LIVE_API_KEY_ENV}" >&2
  exit 2
fi

export MASKAGENT_HOME
rm -rf "$MASKAGENT_LIVE_WORKSPACE"
mkdir -p "$MASKAGENT_LIVE_WORKSPACE"

"${CLI[@]}" init \
  --name live-openai-compatible-smoke \
  --goal 'Create hello.txt containing exactly hello from maskagent live llm' \
  --workspace "$MASKAGENT_LIVE_WORKSPACE" \
  --adapter-id "$MASKAGENT_LIVE_ADAPTER_ID" \
  --provider-type openai_compatible \
  --base-url "$MASKAGENT_LIVE_BASE_URL" \
  --api-key-env "$MASKAGENT_LIVE_API_KEY_ENV" \
  --model "$MASKAGENT_LIVE_MODEL" \
  --validate "grep -q 'hello from maskagent live llm' hello.txt" \
  --accept 'test -f hello.txt'

"${CLI[@]}" run --max-steps 3
"${CLI[@]}" accept
"${CLI[@]}" status
