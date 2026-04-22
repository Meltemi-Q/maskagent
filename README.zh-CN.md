# MaskAgent

[English README](README.md)

MaskAgent 是一个面向软件交付任务的本地 mission orchestration CLI，重点解决这些问题：

- 多 step / 多 agent handoff
- 默认 `plan-first`
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
- `llm_worker` 和 `external_cli` mission 默认会走 `plan -> execute -> accept`
- worker 成功和 mission 最终 acceptance 分离。
- 不落盘 raw API key，只存 `apiKeyEnvVar`。
- 运行中的 shell / external CLI worker 支持响应 `pause.requested`，暂停后会把当前 step 重新排回待执行。
- 支持 `ask_user` step；遇到关键问题时可以暂停 mission，等待人工回答后继续。

## 仓库结构

```text
src/cli.ts                         TypeScript CLI 入口
src/runtime.ts                     TypeScript 运行时与状态机
src/browser-platformer-check.ts    浏览器级验证脚本
tests/runtime.test.mjs             Node test 覆盖
scripts/live-openai-compatible-smoke.sh
scripts/live-minimax-anthropic-smoke.sh
scripts/claude_tmux_worker.sh
scripts/live-claude-tmux-smoke.sh
scripts/run_benchmark_mario_byok.sh
scripts/run_benchmark_mario_claude_tmux.sh
scripts/run_benchmark_mario_all.sh
VALIDATION.md                       验证记录与 live test 结果
```

## 安装与运行

安装依赖并构建：

```bash
cd maskagent
npm install
npm run build
node dist/cli.js --version
```

npm 全局安装：

```bash
cd maskagent
npm install -g . --force
mission --version
maskagent --version
```

交互式引导：

```bash
mission
mission guide
```

首屏会展示：

- 最近一个 mission
- 默认 worker / model / reasoning 设置
- `Create mission / Continue latest / Browse missions / 模型设置`

直接从源码运行：

```bash
cd maskagent
node dist/cli.js --help
```

说明：

- 当前 runtime 已迁到 TypeScript / Node。
- 推荐安装方式是 `npm install -g . --force`。如果 PATH 上已有旧的 Python 版 `mission` / `maskagent`，这个命令会直接覆盖。
- 如果你只想在仓库里跑，不需要全局安装，`npm install && npm run build` 后执行 `node dist/cli.js` 即可。
- 在交互式终端里直接执行 `mission` / `maskagent`，会进入 guide；如果是脚本环境，无参数时会回落到 `--help`。
- guide 的默认配置会持久化到 `~/.maskagent/guide-settings.json`；如果你自定义了 `MASKAGENT_HOME`，则会落到该 missions 目录的上一级。

## 测试

```bash
npm test
```

## 快速开始

先用一个确定性的 shell worker 做最小闭环：

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

如果你不想手写参数，也可以直接运行 `mission`，按 guide 选择：

- 创建 mission
- 选择 BYOK / Claude tmux / shell worker
- 修改默认模型、Base URL、API key env、reasoning effort
- 是否立即 `run`
- 是否继续跑 `acceptance`

当前调度器说明：

- 现在是基于 `dependsOn` 的 DAG scheduler
- 彼此独立、已满足依赖的 step 可以并发执行
- `mission run`、`mission resume`、`mission restart` 支持 `--max-parallel`
- 最终 acceptance 仍然是显式 barrier，需要单独执行 `mission accept`

规划行为：

- `llm_worker` 和 `external_cli` mission 默认启用 `plan-first`
- runtime 会先插入一个 `model_plan` step，再进入真正的 worker step
- `shell` mission 默认仍然直接执行
- 如果你想显式指定，也可以用 `mission init --plan-first`

并发执行示例：

```bash
mission run <mission-id> --max-steps 20 --max-parallel 4
mission resume <mission-id> --run --max-steps 20 --max-parallel 4
```

现在 `mission status` / guide 页面里也会显示当前 active step 列表和 `maxParallel`。

## Plan-First 与 ask_user

为什么默认先做 `plan`：

- orchestration 先要有 step graph，后面的 handoff / retry / validator 才有骨架
- 默认路径变成 `goal -> plan -> worker -> acceptance`
- 大任务里，plan step 可以插入一个或多个 `ask_user` step，再继续往后执行

`ask_user` 不应该滥用。更适合问用户的情况是：

- 缺的信息会改变目标行为或范围
- 会改变架构、workspace 边界或执行路径
- 缺少 credentials / environment / rollout 目标
- validator / acceptance 标准不明确

不适合问的情况：

- 低影响的命名、样式、偏好
- worker 自己可以安全推断的细节
- 不影响闭环结果的小选择

mission 因问题停住后，可以这样回答：

```bash
mission status <mission-id>
mission answer <mission-id> --step-id step-ask-1 --response "先面向 production 环境。"
mission run <mission-id>
```

你也可以手动加一个 `ask_user` step：

```bash
mission step add <mission-id> \
  --step-id step-ask-1 \
  --title "确认目标环境" \
  --type ask_user \
  --question "这次变更应该先面向哪个环境？" \
  --reason "不同环境会影响验证方式和 rollout 风险。"
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

如果你只想先产出 plan，不立刻进入 worker 执行，可以这样：

```bash
mission init \
  --name "plan only demo" \
  --goal "先为这个仓库生成实现计划" \
  --workspace /path/to/repo \
  --adapter-id gpt-proxy-mini \
  --provider-type openai_compatible \
  --base-url "https://gpt.meltemi.fun/v1" \
  --api-key-env GPT_PROXY_API_KEY \
  --model gpt-5.4-mini \
  --plan-only
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

这里我做成了 `src/browser-platformer-check.ts`，编译后对应 `dist/browser-platformer-check.js`，它会：

- 在 workspace 里起一个临时静态服务器
- 用本机的 `Chrome/Edge` headless 打开页面
- 导出浏览器渲染后的 DOM
- 生成一张页面截图
- 校验页面里是否真的出现 `canvas`、`platformer`、`move`、`jump` 这些关键 UI 文本

单独运行方式：

```bash
node dist/browser-platformer-check.js /path/to/workspace
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
