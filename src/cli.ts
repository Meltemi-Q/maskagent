#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, CommanderError, Option } from "commander";
import {
  VERSION,
  MissionNotFoundError,
  abortMission,
  acceptMission,
  addAdapter,
  addStep,
  createMission,
  exportMission,
  homeDir,
  listAdapters,
  pauseMission,
  resolveMissionDir,
  restartMission,
  resumeMission,
  runMission,
  statusObject,
  testAdapter,
} from "./runtime.js";

function collect(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function print(value: string): void {
  process.stdout.write(`${value}\n`);
}

function printJson(value: any): void {
  print(JSON.stringify(value, null, 2));
}

function statusSummary(result: any): string {
  return `run status: ${result.status}${(result.ranSteps || [])
    .map((entry: any) => `\n- ${entry.stepId}: worker=${entry.workerStatus} validation=${entry.validation}`)
    .join("")}`;
}

function acceptanceSummary(result: any): string {
  const validation = result.validation || {};
  const checks = (validation.checkResults || [])
    .map((entry: any) => `- ${entry.name}: ${entry.status} exit=${entry.exitCode}`)
    .join("\n");
  return `accept status: ${result.status}\nvalidation: ${validation.result} — ${validation.summary}${checks ? `\n${checks}` : ""}`;
}

function humanStatus(value: any): string {
  const lines = [
    `Mission: ${value.missionId} — ${value.name}`,
    `Dir:     ${value.missionDir}`,
    `State:   ${value.state} / ${value.phase} / ${value.status}`,
    `Current: ${value.resumeFrom} latestAttempt=${value.latestAttemptId} latestValidation=${value.latestValidationId}`,
    `Locked:  ${value.locked} pauseRequested=${value.pauseRequested}`,
    "Steps:",
    ...(value.steps || []).map(
      (step: any) =>
        `- ${String(step.stepId).padEnd(18)} ${String(step.status).padEnd(16)} attempts=${step.attemptCount}/${step.retryBudget} ${step.title}`,
    ),
  ];
  return lines.join("\n");
}

function shellQuote(value: string): string {
  if (!value.length) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseListInput(value: string): string[] {
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function defaultClaudeWorkerCommand(): string {
  try {
    const wrapperPath = fs.realpathSync.native(new URL("../scripts/claude_tmux_worker.sh", import.meta.url));
    return `bash ${shellQuote(wrapperPath)} {workspace} {prompt_file} {mission_dir}`;
  } catch {
    return "bash /abs/path/to/maskagent/scripts/claude_tmux_worker.sh {workspace} {prompt_file} {mission_dir}";
  }
}

function listRecentMissions(): Array<Record<string, string>> {
  const rootDir = homeDir();
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  return fs
    .readdirSync(rootDir)
    .map((entry) => {
      const missionDir = path.join(rootDir, entry);
      const statePath = path.join(missionDir, "state.json");
      if (!fs.existsSync(statePath)) {
        return null;
      }
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        return {
          id: state.missionId || entry,
          dir: missionDir,
          name: state.name || entry,
          state: state.state || "unknown",
          status: state.status || "unknown",
          updatedAt: state.updatedAt || state.createdAt || "",
        };
      } catch {
        return null;
      }
    })
    .filter(
      (
        entry,
      ): entry is { id: string; dir: string; name: string; state: string; status: string; updatedAt: string } =>
        entry !== null,
    )
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || "") || fs.statSync(left.dir).mtimeMs;
      const rightTime = Date.parse(right.updatedAt || "") || fs.statSync(right.dir).mtimeMs;
      return rightTime - leftTime;
    });
}

type PromptSession = {
  close: () => void;
  question: (prompt: string) => Promise<string>;
};

class PromptInputClosedError extends Error {}

function createBufferedPromptSession(): PromptSession {
  const lines = fs.readFileSync(0, "utf8").split(/\r?\n/);
  let index = 0;
  return {
    close() {},
    async question(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      if (index >= lines.length) {
        throw new PromptInputClosedError("guide stdin exhausted");
      }
      return lines[index++];
    },
  };
}

async function promptLine(
  rl: PromptSession,
  label: string,
  options: { defaultValue?: string; required?: boolean } = {},
): Promise<string> {
  const suffix = options.defaultValue !== undefined ? ` [${options.defaultValue}]` : "";
  while (true) {
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    if (answer) {
      return answer;
    }
    if (options.defaultValue !== undefined) {
      return options.defaultValue;
    }
    if (!options.required) {
      return "";
    }
    print("请输入内容。");
  }
}

async function promptChoice(
  rl: PromptSession,
  label: string,
  choices: Array<{ value: string; label: string }>,
  defaultIndex = 0,
): Promise<string> {
  print(label);
  for (const [index, choice] of choices.entries()) {
    print(`  ${index + 1}. ${choice.label}`);
  }
  while (true) {
    const answer = (await rl.question(`选择 [${defaultIndex + 1}]: `)).trim();
    if (!answer) {
      return choices[defaultIndex].value;
    }
    const numeric = Number(answer);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
      return choices[numeric - 1].value;
    }
    print("请输入有效编号。");
  }
}

async function promptYesNo(rl: PromptSession, label: string, defaultValue = true): Promise<boolean> {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await rl.question(`${label} ${hint}: `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (["y", "yes", "1", "是"].includes(answer)) {
      return true;
    }
    if (["n", "no", "0", "否"].includes(answer)) {
      return false;
    }
    print("请输入 y 或 n。");
  }
}

async function promptNumber(
  rl: PromptSession,
  label: string,
  options: { defaultValue: number; min?: number } = { defaultValue: 0 },
): Promise<number> {
  while (true) {
    const answer = await promptLine(rl, label, { defaultValue: String(options.defaultValue) });
    const numeric = Number(answer);
    if (Number.isFinite(numeric) && Number.isInteger(numeric) && numeric >= (options.min ?? Number.MIN_SAFE_INTEGER)) {
      return numeric;
    }
    print("请输入有效整数。");
  }
}

async function promptMissionSelection(rl: PromptSession, actionLabel: string): Promise<string | null> {
  const missions = listRecentMissions().slice(0, 10);
  if (!missions.length) {
    const manual = await promptLine(rl, `${actionLabel}的 mission id 或路径（留空返回）`);
    if (!manual) {
      return null;
    }
    return resolveMissionDir(manual);
  }
  print(`${actionLabel} mission：`);
  for (const [index, mission] of missions.entries()) {
    print(`  ${index + 1}. ${mission.id}  [${mission.state}/${mission.status}]  ${mission.name}`);
  }
  print("  m. 手动输入 mission id 或路径");
  while (true) {
    const answer = (await rl.question("选择 [1]: ")).trim();
    if (!answer) {
      return missions[0].dir;
    }
    if (answer.toLowerCase() === "m") {
      const manual = await promptLine(rl, "mission id 或路径", { required: true });
      return resolveMissionDir(manual);
    }
    const numeric = Number(answer);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= missions.length) {
      return missions[numeric - 1].dir;
    }
    print("请输入有效编号。");
  }
}

async function guideCreateMission(rl: PromptSession): Promise<void> {
  print("创建 mission");
  const name = await promptLine(rl, "Mission 名称", { defaultValue: "guided mission" });
  const goal = await promptLine(rl, "Mission goal", { required: true });
  const workspace = path.resolve(await promptLine(rl, "Workspace 路径", { defaultValue: process.cwd() }));
  const constraints = parseListInput(await promptLine(rl, "Constraints（可选，用 ; 分隔）"));

  const workerType = await promptChoice(
    rl,
    "选择 worker 类型：",
    [
      { value: "llm_worker", label: "BYOK llm_worker" },
      { value: "external_cli", label: "Claude Code via tmux" },
      { value: "shell", label: "shell command" },
    ],
    0,
  );

  const validateCommand = await promptLine(rl, "Step validate command（可选）");
  const acceptCommand = await promptLine(rl, "Mission accept command（可选）");

  const missionOptions: Record<string, any> = {
    name,
    goal,
    workspace,
    constraint: constraints,
    validate: validateCommand ? [validateCommand] : [],
    accept: acceptCommand ? [acceptCommand] : [],
    retryBudget: 2,
    reasoningEffort: "medium",
  };

  if (workerType === "llm_worker") {
    const preset = await promptChoice(
      rl,
      "选择 BYOK preset：",
      [
        { value: "gpt_proxy", label: "GPT Proxy (OpenAI-compatible, env GPT_PROXY_API_KEY)" },
        { value: "minimax", label: "MiniMax (Anthropic-compatible, env MINIMAX_API_KEY)" },
        { value: "custom_openai", label: "Custom OpenAI-compatible" },
        { value: "custom_anthropic", label: "Custom Anthropic-compatible" },
      ],
      0,
    );

    if (preset === "gpt_proxy") {
      missionOptions.adapterId = await promptLine(rl, "Adapter id", { defaultValue: "gpt-proxy-mini" });
      missionOptions.providerType = "openai_compatible";
      missionOptions.baseUrl = "https://gpt.meltemi.fun/v1";
      missionOptions.apiKeyEnv = "GPT_PROXY_API_KEY";
      missionOptions.model = await promptLine(rl, "Model", { defaultValue: "gpt-5.4-mini" });
    } else if (preset === "minimax") {
      missionOptions.adapterId = await promptLine(rl, "Adapter id", { defaultValue: "minimax-m2" });
      missionOptions.providerType = "anthropic_compatible";
      missionOptions.baseUrl = "https://api.minimaxi.com/anthropic";
      missionOptions.apiKeyEnv = "MINIMAX_API_KEY";
      missionOptions.model = await promptLine(rl, "Model", { defaultValue: "MiniMax-M2.7" });
    } else {
      missionOptions.adapterId = await promptLine(rl, "Adapter id", { defaultValue: "byok-custom" });
      missionOptions.providerType = preset === "custom_openai" ? "openai_compatible" : "anthropic_compatible";
      missionOptions.baseUrl = await promptLine(rl, "Base URL", { required: true });
      missionOptions.apiKeyEnv = await promptLine(rl, "API key env var", { required: true });
      missionOptions.model = await promptLine(rl, "Model", { required: true });
    }

    if (missionOptions.apiKeyEnv && !process.env[missionOptions.apiKeyEnv]) {
      print(`提示: 当前 shell 没设置 ${missionOptions.apiKeyEnv}，运行 mission 时会失败。`);
    }
  } else if (workerType === "external_cli") {
    missionOptions.workerCommand = await promptLine(rl, "Claude worker command", {
      defaultValue: defaultClaudeWorkerCommand(),
      required: true,
    });
    print("提示: 这条链路要求本机有 claude、tmux，且 claude 已登录。");
  } else {
    missionOptions.stepCommand = await promptLine(rl, "Shell command", { required: true });
    const stepTitle = await promptLine(rl, "Step 标题（可选）");
    if (stepTitle) {
      missionOptions.stepTitle = stepTitle;
    }
  }

  const created = createMission(missionOptions as any);
  print(`已创建 mission ${created.missionId}`);
  print(`Mission dir: ${created.missionDir}`);

  if (!(await promptYesNo(rl, "现在直接 run 吗？", true))) {
    return;
  }

  const maxSteps = await promptNumber(rl, "max steps", { defaultValue: 10, min: 1 });
  const runResult = await runMission(created.missionDir, maxSteps, false, false);
  print(statusSummary(runResult));

  if (missionOptions.accept.length && await promptYesNo(rl, "继续跑 acceptance 吗？", true)) {
    print(acceptanceSummary(await acceptMission(created.missionDir)));
  }

  print(humanStatus(statusObject(created.missionDir)));
}

async function guideRunMission(rl: PromptSession): Promise<void> {
  const missionDir = await promptMissionSelection(rl, "运行");
  if (!missionDir) {
    return;
  }
  const maxSteps = await promptNumber(rl, "max steps", { defaultValue: 10, min: 1 });
  print(statusSummary(await runMission(missionDir, maxSteps, false, false)));
}

async function guideStatusMission(rl: PromptSession): Promise<void> {
  const missionDir = await promptMissionSelection(rl, "查看");
  if (!missionDir) {
    return;
  }
  print(humanStatus(statusObject(missionDir)));
}

async function guidePauseMission(rl: PromptSession): Promise<void> {
  const missionDir = await promptMissionSelection(rl, "暂停");
  if (!missionDir) {
    return;
  }
  const result = pauseMission(missionDir);
  print(`pause requested: ${result.resumeFrom}`);
}

async function guideResumeMission(rl: PromptSession): Promise<void> {
  const missionDir = await promptMissionSelection(rl, "恢复");
  if (!missionDir) {
    return;
  }
  const maxSteps = await promptNumber(rl, "max steps", { defaultValue: 10, min: 1 });
  const result = await resumeMission(missionDir, true, maxSteps);
  print(`resumed: ${result.status} resumeFrom=${result.resumeFrom}`);
}

async function guideRestartMission(rl: PromptSession): Promise<void> {
  const missionDir = await promptMissionSelection(rl, "重跑");
  if (!missionDir) {
    return;
  }
  const maxSteps = await promptNumber(rl, "max steps", { defaultValue: 10, min: 1 });
  const result = await restartMission(missionDir, true, maxSteps);
  print(`restart: ${result.status} resumeFrom=${result.resumeFrom}`);
}

async function guideAcceptMission(rl: PromptSession): Promise<void> {
  const missionDir = await promptMissionSelection(rl, "验收");
  if (!missionDir) {
    return;
  }
  print(acceptanceSummary(await acceptMission(missionDir)));
}

async function runGuide(): Promise<number> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl: PromptSession = interactive
    ? createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      })
    : createBufferedPromptSession();
  print("MaskAgent guide");
  print(`Mission home: ${homeDir()}`);
  print("提示: 直接按 Enter 会采用默认值，Ctrl+C 可退出。");
  try {
    while (true) {
      print("");
      const action = await promptChoice(
        rl,
        "选择操作：",
        [
          { value: "create", label: "创建 mission" },
          { value: "run", label: "运行 mission" },
          { value: "status", label: "查看状态" },
          { value: "pause", label: "暂停 mission" },
          { value: "resume", label: "恢复并继续 run" },
          { value: "restart", label: "restart 并继续 run" },
          { value: "accept", label: "执行 acceptance" },
          { value: "exit", label: "退出" },
        ],
        0,
      );
      print("");
      try {
        if (action === "create") {
          await guideCreateMission(rl);
        } else if (action === "run") {
          await guideRunMission(rl);
        } else if (action === "status") {
          await guideStatusMission(rl);
        } else if (action === "pause") {
          await guidePauseMission(rl);
        } else if (action === "resume") {
          await guideResumeMission(rl);
        } else if (action === "restart") {
          await guideRestartMission(rl);
        } else if (action === "accept") {
          await guideAcceptMission(rl);
        } else {
          print("已退出 guide。");
          return 0;
        }
      } catch (error) {
        if (error instanceof PromptInputClosedError) {
          print("guide input ended.");
          return 1;
        }
        if (error instanceof Error) {
          print(error.message);
        } else {
          print(String(error));
        }
      }
    }
  } finally {
    rl.close();
  }
}

async function run(argv: string[]): Promise<number> {
  const program = new Command();
  let exitCode = 0;

  program.name("mission").version(`mission ${VERSION}`, "--version").showHelpAfterError();
  program.exitOverride();
  program
    .command("guide")
    .description("open interactive guide")
    .action(async () => {
      exitCode = await runGuide();
    });

  const init = program.command("init");
  init
    .requiredOption("--name <name>")
    .requiredOption("--goal <goal>")
    .option("--mission-id <missionId>")
    .option("--workspace <workspace>", ".", ".")
    .option("--constraint <constraint>", "", collect, [])
    .option("--accept <command>", "", collect, [])
    .option("--validate <command>", "", collect, [])
    .option("--worker-command <command>")
    .option("--step-command <command>")
    .option("--step-title <title>")
    .option("--retry-budget <count>", "", "2")
    .option("--force")
    .option("--json")
    .option("--adapter-id <adapterId>")
    .option("--adapter-label <adapterLabel>")
    .addOption(
      new Option("--provider-type <providerType>").choices([
        "openai_compatible",
        "anthropic_compatible",
        "custom_gateway",
        "cli_command",
        "external_cli",
      ]).default("openai_compatible"),
    )
    .option("--base-url <baseUrl>")
    .option("--api-key-env <apiKeyEnv>")
    .option("--model <model>")
    .option("--timeout-ms <timeoutMs>", "", "30000")
    .option("--adapter-retries <retries>", "", "1")
    .option("--adapter-backoff-ms <backoffMs>", "", "500")
    .option("--capability <capability>", "", collect, [])
    .option("--adapter-notes <notes>")
    .option("--reasoning-effort <reasoningEffort>", "", "medium")
    .option("--allow-model-commands")
    .option("--plan-only")
    .action((options) => {
      const result = createMission({
        missionId: options.missionId,
        name: options.name,
        goal: options.goal,
        workspace: options.workspace,
        constraint: options.constraint,
        accept: options.accept,
        validate: options.validate,
        workerCommand: options.workerCommand,
        stepCommand: options.stepCommand,
        stepTitle: options.stepTitle,
        retryBudget: Number(options.retryBudget),
        force: Boolean(options.force),
        adapterId: options.adapterId,
        adapterLabel: options.adapterLabel,
        providerType: options.providerType,
        baseUrl: options.baseUrl,
        apiKeyEnv: options.apiKeyEnv,
        model: options.model,
        timeoutMs: Number(options.timeoutMs),
        adapterRetries: Number(options.adapterRetries),
        adapterBackoffMs: Number(options.adapterBackoffMs),
        capability: options.capability,
        adapterNotes: options.adapterNotes,
        reasoningEffort: options.reasoningEffort,
        allowModelCommands: Boolean(options.allowModelCommands),
        planOnly: Boolean(options.planOnly),
      });
      if (options.json) {
        printJson(result);
      } else {
        print(
          `Created mission ${result.missionId}\nMission dir: ${result.missionDir}\nWorkspace:   ${resolveMissionDir(result.missionDir) === result.missionDir ? statusObject(result.missionDir).workingDirectory : ""}`.trim(),
        );
        print(`Next:        mission run ${result.missionId}`);
      }
      exitCode = 0;
    });

  const addMissionTarget = (command: Command) =>
    command.argument("[mission]").option("--json").hook("preAction", (_cmd) => undefined);

  addMissionTarget(
    program
      .command("run")
      .option("--max-steps <maxSteps>", "", "10")
      .option("--resume")
      .option("--allow-stale-lock")
      .action(async (mission, options) => {
        const result = await runMission(
          resolveMissionDir(mission),
          Number(options.maxSteps),
          Boolean(options.resume),
          Boolean(options.allowStaleLock),
        );
        if (options.json) {
          printJson(result);
        } else {
          print(statusSummary(result));
        }
        exitCode = result.ok ? 0 : 1;
      }),
  );

  addMissionTarget(
    program.command("status").action((mission, options) => {
      const result = statusObject(resolveMissionDir(mission));
      if (options.json) {
        printJson(result);
      } else {
        print(humanStatus(result));
      }
      exitCode = 0;
    }),
  );

  addMissionTarget(
    program.command("pause").action((mission, options) => {
      const result = pauseMission(resolveMissionDir(mission));
      if (options.json) {
        printJson(result);
      } else {
        print(`pause requested: ${result.resumeFrom}`);
      }
      exitCode = 0;
    }),
  );

  addMissionTarget(
    program
      .command("resume")
      .option("--run")
      .option("--max-steps <maxSteps>", "", "10")
      .action(async (mission, options) => {
        const result = await resumeMission(resolveMissionDir(mission), Boolean(options.run), Number(options.maxSteps));
        if (options.json) {
          printJson(result);
        } else {
          print(`resumed: ${result.status} resumeFrom=${result.resumeFrom}`);
        }
        exitCode = result.ok ? 0 : 1;
      }),
  );

  addMissionTarget(
    program
      .command("restart")
      .option("--run")
      .option("--max-steps <maxSteps>", "", "10")
      .action(async (mission, options) => {
        const result = await restartMission(resolveMissionDir(mission), Boolean(options.run), Number(options.maxSteps));
        if (options.json) {
          printJson(result);
        } else {
          print(`restart: ${result.status} resumeFrom=${result.resumeFrom}`);
        }
        exitCode = result.ok ? 0 : 1;
      }),
  );

  addMissionTarget(
    program.command("accept").action(async (mission, options) => {
      const result = await acceptMission(resolveMissionDir(mission));
      if (options.json) {
        printJson(result);
      } else {
        print(acceptanceSummary(result));
      }
      exitCode = result.ok ? 0 : 1;
    }),
  );

  addMissionTarget(
    program.command("abort").option("--reason <reason>").action((mission, options) => {
      const result = abortMission(resolveMissionDir(mission), options.reason);
      if (options.json) {
        printJson(result);
      } else {
        print("mission aborted");
      }
      exitCode = result.ok ? 0 : 1;
    }),
  );

  addMissionTarget(
    program.command("export").option("--output <output>").action(async (mission, options) => {
      const result = await exportMission(resolveMissionDir(mission), options.output);
      if (options.json) {
        printJson(result);
      } else {
        print(`exported: ${result.path}`);
      }
      exitCode = result.ok ? 0 : 1;
    }),
  );

  const step = program.command("step");
  step
    .command("add")
    .argument("<mission>")
    .requiredOption("--title <title>")
    .option("--step-id <stepId>")
    .option("--objective <objective>")
    .addOption(
      new Option("--type <type>").choices([
        "shell",
        "external_cli",
        "model_plan",
        "llm_worker",
        "model_patch",
        "model",
        "noop",
        "acceptance",
      ]).default("llm_worker"),
    )
    .option("--owner <owner>", "", "worker")
    .option("--command <command>")
    .option("--command-template <commandTemplate>")
    .option("--adapter-ref <adapterRef>")
    .option("--validate <command>", "", collect, [])
    .option("--depends-on <stepId>", "", collect, [])
    .option("--retry-budget <count>", "", "2")
    .option("--allow-model-commands")
    .option("--json")
    .action((mission, options) => {
      const result = addStep(resolveMissionDir(mission), {
        stepId: options.stepId,
        title: options.title,
        objective: options.objective,
        type: options.type,
        owner: options.owner,
        command: options.command,
        commandTemplate: options.commandTemplate,
        adapterRef: options.adapterRef,
        validate: options.validate,
        dependsOn: options.dependsOn,
        retryBudget: Number(options.retryBudget),
        allowModelCommands: Boolean(options.allowModelCommands),
      });
      if (options.json) {
        printJson(result);
      } else {
        print(`added step: ${result.step.stepId}`);
      }
      exitCode = 0;
    });

  const adapters = program.command("adapters");
  adapters
    .command("add")
    .argument("<mission>")
    .requiredOption("--adapter-id <adapterId>")
    .addOption(
      new Option("--provider-type <providerType>").choices([
        "openai_compatible",
        "anthropic_compatible",
        "custom_gateway",
        "cli_command",
        "external_cli",
      ]).makeOptionMandatory(),
    )
    .option("--label <label>")
    .option("--base-url <baseUrl>")
    .option("--api-key-env <apiKeyEnv>")
    .option("--api-key <apiKey>")
    .option("--model <model>")
    .option("--command <command>")
    .option("--timeout-ms <timeoutMs>", "", "30000")
    .option("--retries <retries>", "", "1")
    .option("--backoff-ms <backoffMs>", "", "500")
    .option("--fallback <adapterId>", "", collect, [])
    .option("--capability <capability>", "", collect, [])
    .option("--max-output-tokens <count>")
    .option("--disabled")
    .option("--notes <notes>")
    .option("--role <role>", "", collect, [])
    .option("--json")
    .action((mission, options) => {
      const result = addAdapter(resolveMissionDir(mission), {
        adapterId: options.adapterId,
        providerType: options.providerType,
        label: options.label,
        baseUrl: options.baseUrl,
        apiKeyEnv: options.apiKeyEnv,
        apiKey: options.apiKey,
        model: options.model,
        command: options.command,
        timeoutMs: Number(options.timeoutMs),
        retries: Number(options.retries),
        backoffMs: Number(options.backoffMs),
        fallback: options.fallback,
        capability: options.capability,
        maxOutputTokens: options.maxOutputTokens ? Number(options.maxOutputTokens) : undefined,
        disabled: Boolean(options.disabled),
        notes: options.notes,
        role: options.role,
      });
      if (options.json) {
        printJson(result);
      } else {
        print(`adapter saved: ${options.adapterId}`);
      }
      exitCode = 0;
    });

  adapters.command("list").argument("<mission>").option("--json").action((mission, options) => {
    const result = listAdapters(resolveMissionDir(mission));
    if (options.json) {
      printJson(result);
    } else {
      print(
        (result.adapters || [])
          .map(
            (entry: any) =>
              `- ${String(entry.id).padEnd(24)} ${String(entry.providerType || entry.provider).padEnd(22)} model=${entry.modelName || entry.model} env=${entry.apiKeyEnvVar || "-"} enabled=${entry.enabled !== false}`,
          )
          .join("\n"),
      );
    }
    exitCode = 0;
  });

  adapters
    .command("test")
    .argument("<mission>")
    .argument("<adapterId>")
    .option("--prompt <prompt>", "", "Reply with OK and one short sentence.")
    .option("--json")
    .action(async (mission, adapterId, options) => {
      const result = await testAdapter(resolveMissionDir(mission), adapterId, options.prompt);
      if (options.json) {
        printJson(result);
      } else if (result.ok) {
        print(`adapter ok: ${result.adapterId} model=${result.model} duration=${result.durationMs}ms\n${result.contentPreview}`);
      } else {
        print(`adapter failed: ${result.error} ${result.message}`);
      }
      exitCode = result.ok ? 0 : 1;
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof MissionNotFoundError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    if (error instanceof Error && error.message.startsWith("Mission exists:")) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    if (error instanceof Error) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    process.stderr.write(`${String(error)}\n`);
    return 1;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (!argv.length) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        return await runGuide();
      }
      return await run(["--help"]);
    }
    return await run(argv);
  } catch (error) {
    if (error instanceof MissionNotFoundError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    if (error instanceof Error) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    process.stderr.write(`${String(error)}\n`);
    return 1;
  }
}

const entryPath = process.argv[1] ? fs.realpathSync.native(process.argv[1]) : "";
const modulePath = fs.realpathSync.native(new URL(import.meta.url));

if (entryPath && modulePath === entryPath) {
  main().then((code) => {
    process.exitCode = code;
  });
}
