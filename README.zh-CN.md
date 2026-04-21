# MaskAgent

[English README](README.md)

MaskAgent 是一个面向软件交付任务的本地 mission orchestration CLI，重点解决这些问题：

- 多 step / 多 agent handoff
- 持久化 mission state
- worker -> validator -> acceptance 闭环
- pause / resume / restart
- BYOK model adapter
- Claude Code、Codex 这类 external CLI worker 接入

它不是一个简单的 prompt wrapper。每个 mission 都会落地为一组可恢复的状态文件、attempt 记录、evidence、handoff 和 validation 结果。

## 产品能力

- 默认把 mission 存到 `~/.maskagent/missions/<mission-id>/`，也支持用 `$MASKAGENT_HOME` 覆盖。
- 持久化 `state.json`、`features.json`、`validation-state.json`、`model-settings.json`、`runtime-custom-models.json`。
- 追加写入 `attempts.jsonl`、`progress_log.jsonl`、`worker-transcripts.jsonl`、`validation_log.jsonl`、`handoffs/`、`evidence/`。
- 支持三类 worker：
  - `llm_worker`：模型返回严格 JSON，由 runtime 安全写入 workspace
  - `external_cli`：Claude Code、Codex 或任意本地 agent CLI
  - `shell`：确定性 smoke test、validator、CI 检查
- worker 成功和 mission 最终 acceptance 分离。
- 不落盘 raw API key，只存 `apiKeyEnvVar`。
- 运行中的 shell / external CLI worker 支持响应 `pause.requested`，暂停后会把当前 step 重新排回待执行。

## 仓库结构

```text
src/mission_runtime/cli.py          主运行时与 CLI 入口
tests/test_runtime.py               mission 流程测试
scripts/live-openai-compatible-smoke.sh
scripts/live-minimax-anthropic-smoke.sh
scripts/claude_tmux_worker.sh
scripts/live-claude-tmux-smoke.sh
scripts/run_benchmark_mario_byok.sh
scripts/run_benchmark_mario_claude_tmux.sh
scripts/run_benchmark_mario_all.sh
scripts/browser_platformer_check.py
VALIDATION.md                       验证记录与 live test 结果
```

## 安装与运行

直接从源码运行：

```bash
cd maskagent
PYTHONPATH=src python3 -m mission_runtime.cli --version
```

可选 editable install：

```bash
python3 -m pip install -e .
mission --version
maskagent --version
```

## 测试

```bash
PYTHONPATH=src PYTHONNOUSERSITE=1 python3 -S -m unittest discover -s tests -v
```

## 快速开始

先用一个确定性的 shell worker 做最小闭环：

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

## BYOK / Adapter 模式

`OpenAI-compatible` 真实模型闭环：

```bash
export GPT_PROXY_API_KEY="..."
bash scripts/live-openai-compatible-smoke.sh
```

`MiniMax` 的 `Anthropic-compatible` 闭环：

```bash
export MINIMAX_API_KEY="..."
bash scripts/live-minimax-anthropic-smoke.sh
```

手工添加 adapter 的方式：

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

## Claude Code / Codex 这类 external CLI

通过 `tmux` 监控 `Claude Code`：

```bash
bash scripts/live-claude-tmux-smoke.sh
```

直接接 external worker 的示例：

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

`--worker-command` 可用占位符：

- `{prompt_file}`：shell-quoted 的 prompt 文件路径
- `{prompt}`：shell-quoted 的 prompt 文本
- `{workspace}`：shell-quoted 的 workspace 路径
- `{mission_dir}`：shell-quoted 的 mission 目录
- `{raw_prompt}`：未转义的 prompt 文本

## Pause / Resume 语义

- `mission pause` 会写入 `pause.requested`。
- 正在执行的 shell / external CLI worker 会感知这个文件并终止当前 process tree。
- 当前 step 会回到 `pending`，不会消耗一次 retry。
- `mission resume --run` 会从该 step 重新执行。
- `mission restart --run` 会把孤儿中的 step 标记为 `orphan_cleanup`，然后从头续跑。

## 挑战项目 Prompt

推荐拿这些项目做 benchmark：

- 经典软件：markdown editor、Kanban board、file uploader、notes app
- 经典游戏：Snake、2048、Tetris、带多关卡的 Mario-like platformer

你提到的“复杂版超级玛丽，多关卡”很适合作为标准验收题。下面这段 prompt 可以直接拿去喂 `mission init`：

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

这个 benchmark 的好处是：prompt 足够大，能把 planning、worker 执行、validator、retry、handoff 全部压一遍。

## 固定回归 Benchmark

“脚本化进仓库，变成固定回归”的意思是：

- 不再依赖手工敲一长串 benchmark 命令
- 把同一套 Mario benchmark 固定成仓库脚本
- 以后只要跑同一个脚本，就能比较不同 worker / model 的结果

现在仓库里已经有三条固定命令：

```bash
# BYOK llm_worker 跑完整版 Mario benchmark
export GPT_PROXY_API_KEY="..."
bash scripts/run_benchmark_mario_byok.sh

# Claude Code + tmux 跑同一份 benchmark
bash scripts/run_benchmark_mario_claude_tmux.sh

# 顺序跑两条
export GPT_PROXY_API_KEY="..."
bash scripts/run_benchmark_mario_all.sh
```

默认配置：

- `run_benchmark_mario_byok.sh` 默认用 `gpt-5.3-codex-spark`
- 两条脚本都跑同一份 prompt：`scripts/benchmarks/mario-full-goal.txt`
- 两条脚本都会执行：
  - mission `init`
  - mission `run`
  - mission `accept`
  - 浏览器级验证

常用可覆盖环境变量：

- `MASKAGENT_BENCH_HOME`
- `MASKAGENT_BENCH_WORKSPACE`
- `MASKAGENT_BENCH_MISSION_ID`
- `MASKAGENT_BENCH_MODEL`
- `MASKAGENT_BENCH_BASE_URL`
- `MASKAGENT_BENCH_API_KEY_ENV`
- `MASKAGENT_CLAUDE_TIMEOUT_S`

也支持按 runner 分开的变量前缀：

- `MASKAGENT_BYOK_BENCH_*`
- `MASKAGENT_CLAUDE_BENCH_*`

## 浏览器级验证

是的，意思就是“真的在浏览器里跑一下”，而不是只跑 `node smoke-test.mjs`。

这里我做成了 `scripts/browser_platformer_check.py`，它会：

- 在 workspace 里起一个临时静态服务器
- 用本机的 `Chrome/Edge` headless 打开页面
- 导出浏览器渲染后的 DOM
- 生成一张页面截图
- 校验页面里是否真的出现 `canvas`、`level`、`score`、`lives`、`coin` 这些关键 UI 文本

单独运行方式：

```bash
python3 scripts/browser_platformer_check.py /path/to/workspace
```

浏览器验证产物会保存在 mission 目录的 `browser-check/` 下，包含：

- `browser-check.png`
- `browser-check.dom.html`
- `browser-check.summary.json`

## 安全说明

- 不要把 raw API key 写进 mission 文件。
- 统一用 `--api-key-env NAME`，把密钥放到环境变量里。
- `mission adapters add --api-key ...` 会被拒绝。
- 日志会自动 redact 常见 token pattern。
- LLM 写文件只允许落在 workspace 内，拒绝绝对路径、`..` 和 `.git` 路径。
