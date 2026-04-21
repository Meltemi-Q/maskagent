#!/usr/bin/env bash
set -euo pipefail

workspace="${1:?workspace is required}"
prompt_file="${2:?prompt_file is required}"
mission_dir="${3:-}"

timeout_s="${MASKAGENT_CLAUDE_TIMEOUT_S:-1800}"
poll_s="${MASKAGENT_CLAUDE_POLL_S:-1}"
session_name="maskagent-claude-${RANDOM}-$$"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for claude_tmux_worker.sh" >&2
  exit 127
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "claude is required for claude_tmux_worker.sh" >&2
  exit 127
fi

log_root="${mission_dir:-${TMPDIR:-/tmp}}"
if [[ -n "${mission_dir}" ]]; then
  log_root="${mission_dir}/artifacts"
fi
mkdir -p "${log_root}"

run_dir="${log_root}/${session_name}"
stdout_file="${run_dir}/stdout.txt"
stderr_file="${run_dir}/stderr.txt"
exit_file="${run_dir}/exit.code"
meta_file="${run_dir}/meta.txt"
mkdir -p "${run_dir}"

printf 'session=%s\nworkspace=%s\nprompt_file=%s\n' "${session_name}" "${workspace}" "${prompt_file}" > "${meta_file}"

quoted_workspace="$(printf '%q' "${workspace}")"
quoted_prompt_file="$(printf '%q' "${prompt_file}")"
quoted_stdout_file="$(printf '%q' "${stdout_file}")"
quoted_stderr_file="$(printf '%q' "${stderr_file}")"
quoted_exit_file="$(printf '%q' "${exit_file}")"
runner_file="${run_dir}/run.sh"
claude_cmd=(claude -p --permission-mode bypassPermissions)
if [[ -n "${MASKAGENT_CLAUDE_MODEL:-}" ]]; then
  claude_cmd+=(--model "${MASKAGENT_CLAUDE_MODEL}")
fi
if [[ -n "${MASKAGENT_CLAUDE_EFFORT:-}" ]]; then
  claude_cmd+=(--effort "${MASKAGENT_CLAUDE_EFFORT}")
fi

{
  echo "#!/usr/bin/env bash"
  echo "set -euo pipefail"
  printf 'cd %s\n' "${quoted_workspace}"
  printf 'CLAUDE_CODE_ENTRYPOINT=maskagent-tmux-worker '
  printf '%q ' "${claude_cmd[@]}"
  printf '"$(cat %s)" >%s 2>%s\n' "${quoted_prompt_file}" "${quoted_stdout_file}" "${quoted_stderr_file}"
  printf 'status=$?\n'
  printf 'printf '"'"'%%s'"'"' "$status" > %s\n' "${quoted_exit_file}"
} > "${runner_file}"
chmod +x "${runner_file}"

tmux new-session -d -s "${session_name}" "${runner_file}"

started_at="$(date +%s)"
while tmux has-session -t "${session_name}" 2>/dev/null; do
  now_ts="$(date +%s)"
  if (( now_ts - started_at >= timeout_s )); then
    echo "tmux Claude worker timed out after ${timeout_s}s" >&2
    tmux kill-session -t "${session_name}" 2>/dev/null || true
    printf '124' > "${exit_file}"
    printf '\n[TIMEOUT]\n' >> "${stderr_file}"
    break
  fi
  if [[ -n "${mission_dir}" && -f "${mission_dir}/pause.requested" ]]; then
    echo "pause requested; stopping tmux session ${session_name}" >&2
    tmux kill-session -t "${session_name}" 2>/dev/null || true
    printf '130' > "${exit_file}"
    printf '\n[PAUSED]\n' >> "${stderr_file}"
    break
  fi
  sleep "${poll_s}"
done

status="$(cat "${exit_file}" 2>/dev/null || echo 1)"

if [[ -f "${stdout_file}" ]]; then
  cat "${stdout_file}"
fi

{
  echo
  echo "[tmux-session] ${session_name}"
  echo "[tmux-log-dir] ${run_dir}"
  if [[ -f "${stderr_file}" ]]; then
    cat "${stderr_file}"
  fi
} >&2

exit "${status}"
