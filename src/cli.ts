#!/usr/bin/env node

import fs from "node:fs";
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

async function run(argv: string[]): Promise<number> {
  const program = new Command();
  let exitCode = 0;

  program.name("mission").version(`mission ${VERSION}`, "--version").showHelpAfterError();
  program.exitOverride();

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
