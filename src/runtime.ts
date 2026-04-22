import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import * as tar from "tar";

export const VERSION = "0.4.0";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9_.-]{10,}/gi,
  /(x-api-key\s*[:=]\s*)[A-Za-z0-9_.-]{10,}/gi,
  /(api[_-]?key\s*[:=]\s*)[A-Za-z0-9_.-]{10,}/gi,
];

const TRANSIENT_ERRORS = new Set(["timeout", "rate_limited", "transient_provider_error"]);

export class MissionNotFoundError extends Error {}

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function mid(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function homeDir(): string {
  return path.resolve(
    expandHome(
      process.env.MASKAGENT_HOME ||
        process.env.MISSION_HOME ||
        path.join(os.homedir(), ".maskagent", "missions"),
    ),
  );
}

export function expandHome(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  return path.join(os.homedir(), input.slice(1));
}

function ensureDir(target: string): string {
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function readJson(filePath: string, defaultValue: any = undefined): any {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath: string, data: any): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function appendJsonl(filePath: string, data: Record<string, any>): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`, "utf8");
}

function redactText(value: string | undefined | null): string {
  let output = `${value ?? ""}`;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (...args) => {
      const match = args[0];
      const group1 = args[1];
      return group1 ? `${group1}[REDACTED]` : match.replace(match, "[REDACTED]");
    });
  }
  return output;
}

function redact(value: any): any {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === "object") {
    const output: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/(secret|token|password|authorization|api.?key)$/i.test(key)) {
        output[key] =
          typeof entry === "string" && (entry.endsWith("_KEY") || entry.startsWith("${"))
            ? entry
            : "[REDACTED]";
      } else {
        output[key] = redact(entry);
      }
    }
    return output;
  }
  return value;
}

function shortText(value: string | undefined | null, limit = 4000): string {
  const clean = redactText(value);
  if (clean.length <= limit) {
    return clean;
  }
  return `${clean.slice(0, limit)}\n...[truncated ${clean.length - limit} chars]`;
}

function event(missionDir: string, name: string, payload: Record<string, any> = {}): void {
  appendJsonl(path.join(missionDir, "progress_log.jsonl"), redact({
    ts: now(),
    event: name,
    runtime: { pid: process.pid, host: os.hostname() },
    ...payload,
  }));
}

function missionState(missionDir: string): any {
  return readJson(path.join(missionDir, "state.json"), {});
}

function missionFeatures(missionDir: string): any {
  return readJson(path.join(missionDir, "features.json"), { version: 1, steps: [] });
}

function missionValidationState(missionDir: string): any {
  return readJson(path.join(missionDir, "validation-state.json"), { version: 1, assertions: {} });
}

function adapterRegistry(missionDir: string): any {
  return readJson(path.join(missionDir, "runtime-custom-models.json"), {
    version: 1,
    customModels: [],
  });
}

function layout(missionDir: string): void {
  ensureDir(missionDir);
  for (const subdir of ["handoffs", "evidence", "artifacts"]) {
    ensureDir(path.join(missionDir, subdir));
  }
  for (const fileName of [
    "progress_log.jsonl",
    "worker-transcripts.jsonl",
    "attempts.jsonl",
    "validation_log.jsonl",
  ]) {
    const target = path.join(missionDir, fileName);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, "", "utf8");
    }
  }
}

function newestMissionDir(rootDir: string): string {
  if (!fs.existsSync(rootDir)) {
    throw new MissionNotFoundError(`no missions in ${rootDir}`);
  }
  const dirs = fs
    .readdirSync(rootDir)
    .map((name) => path.join(rootDir, name))
    .filter((candidate) => fs.existsSync(path.join(candidate, "state.json")))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  if (!dirs.length) {
    throw new MissionNotFoundError(`no missions in ${rootDir}`);
  }
  return dirs[0];
}

export function resolveMissionDir(input?: string | null): string {
  const rootDir = homeDir();
  if (!input) {
    return newestMissionDir(rootDir);
  }
  const directPath = path.resolve(expandHome(input));
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  const namedPath = path.join(rootDir, input);
  if (fs.existsSync(namedPath)) {
    return namedPath;
  }
  if (fs.existsSync(rootDir)) {
    const matches = fs
      .readdirSync(rootDir)
      .filter((name) => name.startsWith(input))
      .map((name) => path.join(rootDir, name));
    if (matches.length === 1) {
      return matches[0];
    }
  }
  throw new MissionNotFoundError(`mission not found: ${input}`);
}

function shellQuote(value: string): string {
  if (!value.length) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/gi, (_match, key) => values[key] ?? "");
}

async function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  closePromise: Promise<number | null>,
  waitMs = 5000,
): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const exited = await Promise.race([closePromise, sleep(waitMs, null)]);
  if (exited !== null) {
    return;
  }
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      return;
    }
  }
  await Promise.race([closePromise, sleep(waitMs, null)]);
}

export async function runShell(
  command: string,
  cwd: string,
  timeoutSeconds = 600,
  pauseFile?: string | null,
): Promise<Record<string, any>> {
  const startedAt = Date.now();
  const child = spawn(command, {
    shell: true,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: process.env,
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  let timedOut = false;
  let paused = false;
  let exitCode: number | null = null;
  const closePromise = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      exitCode = code;
      resolve(code);
    });
  });

  child.on("close", (code) => {
    exitCode = code;
  });

  while (exitCode === null) {
    if (pauseFile && fs.existsSync(pauseFile)) {
      paused = true;
      await terminateProcessTree(child, closePromise);
      break;
    }
    if (Date.now() - startedAt >= timeoutSeconds * 1000) {
      timedOut = true;
      await terminateProcessTree(child, closePromise);
      break;
    }
    await sleep(200);
  }

  if (exitCode === null) {
    exitCode = await closePromise;
  }

  let stdout = Buffer.concat(stdoutChunks).toString("utf8");
  let stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (timedOut) {
    stderr += `${stderr ? "\n" : ""}[TIMEOUT]`;
  }
  if (paused) {
    stderr += `${stderr ? "\n" : ""}[PAUSED]`;
  }
  return {
    command,
    cwd,
    exitCode: paused ? 130 : timedOut ? 124 : (exitCode ?? 1),
    stdout: shortText(stdout),
    stderr: shortText(stderr),
    durationMs: Date.now() - startedAt,
    timedOut,
    paused,
  };
}

function acquireLock(missionDir: string, stale = false): string | null {
  const lockPath = path.join(missionDir, "run.lock");
  if (fs.existsSync(lockPath)) {
    const oldLock = readJson(lockPath, {});
    const oldPid = oldLock.pid;
    let alive = false;
    if (typeof oldPid === "number") {
      try {
        process.kill(oldPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive && !stale) {
      return `mission locked by pid=${oldPid}`;
    }
    event(missionDir, "worker_failed", { reason: "orphan_cleanup", previousLock: oldLock });
    fs.rmSync(lockPath, { force: true });
  }
  writeJson(lockPath, { pid: process.pid, host: os.hostname(), createdAt: now() });
  return null;
}

function releaseLock(missionDir: string): void {
  fs.rmSync(path.join(missionDir, "run.lock"), { force: true });
}

function roleAdapterId(missionDir: string, role: string, explicit?: string | null): string | null {
  if (explicit) {
    return explicit;
  }
  const settings = readJson(path.join(missionDir, "model-settings.json"), {});
  const roles = settings.roleAssignments || {};
  return roles[role] || settings[`${role}Model`] || settings.workerModel || settings.defaultAdapterRef || null;
}

function getAdapter(missionDir: string, adapterId?: string | null): Record<string, any> {
  const resolvedId = adapterId || roleAdapterId(missionDir, "worker");
  for (const candidate of adapterRegistry(missionDir).customModels || []) {
    if (candidate.id === resolvedId || candidate.adapterId === resolvedId) {
      if (candidate.enabled === false) {
        throw new Error(`capability_unsupported:adapter disabled: ${resolvedId}`);
      }
      return candidate;
    }
  }
  throw new Error(`adapter not found: ${resolvedId}`);
}

function saveAdapter(missionDir: string, adapter: Record<string, any>): void {
  if (adapter.apiKey || adapter.key || adapter.token) {
    throw new Error("raw API keys are not allowed; use apiKeyEnvVar");
  }
  const registry = adapterRegistry(missionDir);
  const items = registry.customModels || (registry.customModels = []);
  adapter.adapterId ||= adapter.id;
  adapter.enabled ??= true;
  adapter.retryPolicy ||= { maxRetries: 1, backoffMs: 500 };
  adapter.capabilityFlags ||= [];
  const existingIndex = items.findIndex((entry: any) => entry.id === adapter.id);
  if (existingIndex >= 0) {
    items[existingIndex] = { ...items[existingIndex], ...adapter };
  } else {
    items.push(adapter);
  }
  writeJson(path.join(missionDir, "runtime-custom-models.json"), registry);
}

function assignDefined(target: Record<string, any>, values: Record<string, any>): Record<string, any> {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
  return target;
}

async function httpJson(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, any>,
  timeoutSeconds: number,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      const category =
        response.status === 401
          ? "auth_error"
          : response.status === 403
            ? "permission_error"
            : response.status === 404
              ? "model_not_found"
              : response.status === 429
                ? "rate_limited"
                : response.status >= 500 || response.status === 529
                  ? "transient_provider_error"
                  : "invalid_request";
      throw new Error(`${category}:${response.status}:${shortText(bodyText, 800)}`);
    }
    return JSON.parse(bodyText || "{}");
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`timeout:${error.message || "request timed out"}`);
    }
    if (error instanceof Error) {
      if (/^[a-z_]+:/.test(error.message)) {
        throw error;
      }
      throw new Error(`transient_provider_error:${error.message}`);
    }
    throw new Error(`transient_provider_error:${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function errorCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(":") ? message.split(":", 1)[0] : "tool_error";
}

async function callAdapterOnce(
  missionDir: string,
  adapter: Record<string, any>,
  prompt: string,
): Promise<Record<string, any>> {
  const provider = adapter.providerType || adapter.provider || "openai_compatible";
  const model = adapter.modelName || adapter.model;
  const timeoutSeconds = Number(adapter.timeoutMs || 30000) / 1000;
  const startedAt = Date.now();

  let content = "";
  if (provider === "openai_compatible" || provider === "custom_gateway") {
    const apiKey = process.env[adapter.apiKeyEnvVar || ""];
    if (!apiKey) {
      throw new Error(`auth_error:missing env ${adapter.apiKeyEnvVar}`);
    }
    const data = await httpJson(
      `${String(adapter.baseUrl || "").replace(/\/$/, "")}/chat/completions`,
      { Authorization: `Bearer ${apiKey}` },
      { model, messages: [{ role: "user", content: prompt }] },
      timeoutSeconds,
    );
    content = data?.choices?.[0]?.message?.content || "";
  } else if (provider === "anthropic_compatible") {
    const apiKey = process.env[adapter.apiKeyEnvVar || ""];
    if (!apiKey) {
      throw new Error(`auth_error:missing env ${adapter.apiKeyEnvVar}`);
    }
    const data = await httpJson(
      `${String(adapter.baseUrl || "").replace(/\/$/, "")}/v1/messages`,
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      {
        model,
        max_tokens: Number(adapter.maxOutputTokens || 2048),
        messages: [{ role: "user", content: prompt }],
      },
      timeoutSeconds,
    );
    const chunks = Array.isArray(data?.content) ? data.content : [data?.content ?? ""];
    content = chunks.map((entry: any) => (entry && typeof entry === "object" ? entry.text || "" : String(entry))).join("");
  } else if (provider === "cli_command" || provider === "external_cli") {
    const template = adapter.command || adapter.commandTemplate;
    if (!template) {
      throw new Error("invalid_request:missing command");
    }
    const promptPath = path.join(missionDir, "evidence", `${mid("adapter-prompt")}.md`);
    fs.writeFileSync(promptPath, prompt, "utf8");
    const result = await runShell(
      formatTemplate(template, {
        prompt_file: shellQuote(promptPath),
        prompt: shellQuote(prompt),
        raw_prompt: prompt,
        mission_dir: shellQuote(missionDir),
      }),
      missionDir,
      Math.ceil(timeoutSeconds),
    );
    if (result.exitCode !== 0) {
      throw new Error(`tool_error:${result.exitCode}:${result.stderr || result.stdout}`);
    }
    content = result.stdout;
  } else {
    throw new Error(`capability_unsupported:${provider}`);
  }

  return {
    adapterId: adapter.id,
    providerType: provider,
    model,
    content,
    durationMs: Date.now() - startedAt,
  };
}

async function callAdapter(
  missionDir: string,
  adapterId: string | null | undefined,
  prompt: string,
  role = "worker",
): Promise<Record<string, any>> {
  const first = getAdapter(missionDir, adapterId || roleAdapterId(missionDir, role));
  const candidates = [first];
  for (const fallbackId of first.fallbackAdapterIds || []) {
    try {
      candidates.push(getAdapter(missionDir, fallbackId));
    } catch (error) {
      event(missionDir, "adapter_fallback_unavailable", {
        adapterId: fallbackId,
        error: shortText(error instanceof Error ? error.message : String(error), 500),
      });
    }
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    const retryPolicy = candidate.retryPolicy || {};
    const attempts = Number(retryPolicy.maxRetries || 0) + 1;
    const backoffMs = Number(retryPolicy.backoffMs || 250);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const output = await callAdapterOnce(missionDir, candidate, prompt);
        appendJsonl(path.join(missionDir, "worker-transcripts.jsonl"), {
          ts: now(),
          kind: "adapter_call",
          role,
          adapterId: candidate.id,
          model: output.model,
          contentChars: (output.content || "").length,
          attempt: attempt + 1,
        });
        if (attempt || candidate !== first) {
          event(missionDir, "adapter_call_recovered", {
            role,
            adapterId: candidate.id,
            attempt: attempt + 1,
          });
        }
        return output;
      } catch (error) {
        lastError = error;
        const category = errorCategory(error);
        event(missionDir, "adapter_call_failed", {
          role,
          adapterId: candidate.id,
          errorCategory: category,
          attempt: attempt + 1,
          retryable: TRANSIENT_ERRORS.has(category),
        });
        if (!TRANSIENT_ERRORS.has(category) || attempt + 1 >= attempts) {
          break;
        }
        await sleep(backoffMs * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function workerPrompt(state: any, step: any, missionMd: string, retry: any): string {
  return [
    "You are a bounded Worker inside a mission runtime. Produce evidence; validator decides acceptance.",
    "# Mission",
    missionMd.slice(0, 12000),
    "# State",
    JSON.stringify(
      {
        missionId: state.missionId,
        phase: state.phase,
        status: state.status,
        resumeFrom: state.resumeFrom,
      },
      null,
      2,
    ),
    "# Step",
    JSON.stringify(step, null, 2),
    "# Retry",
    JSON.stringify(retry, null, 2),
  ].join("\n");
}

function modelPlanPrompt(state: any, step: any, missionMd: string, retry: any): string {
  const schema = {
    summary: "short plan summary",
    steps: [
      {
        title: "step title",
        objective: "what this step should accomplish",
        owner: "worker|validator|orchestrator",
        dependsOn: ["optional-step-id"],
      },
    ],
    questions: [
      {
        question: "only ask when missing info would materially change implementation",
        reason: "why this blocks or materially changes the result",
      },
    ],
    risks: ["optional list of risks or assumptions"],
  };
  return [
    "You are the planner of a mission orchestration runtime.",
    "Create an execution plan first. Prefer returning one strict JSON object matching the preferred schema below.",
    "Ask the user only when the missing information would materially change architecture, target behavior, acceptance, credentials, or workspace boundaries.",
    "Do not ask for cosmetic preferences, low-impact naming choices, or details the worker can infer safely.",
    "# Preferred JSON schema",
    JSON.stringify(schema, null, 2),
    "# Mission",
    missionMd.slice(0, 12000),
    "# Runtime state",
    JSON.stringify(
      {
        missionId: state.missionId,
        phase: state.phase,
        status: state.status,
        resumeFrom: state.resumeFrom,
        workingDirectory: state.workingDirectory,
      },
      null,
      2,
    ),
    "# Planning step",
    JSON.stringify(step, null, 2),
    "# Retry context",
    JSON.stringify(retry, null, 2),
  ].join("\n");
}

function llmWorkerPrompt(state: any, step: any, missionMd: string, retry: any): string {
  const schema = {
    status: "succeeded|partial|failed|blocked",
    summary: "short human readable summary",
    files: [{ path: "relative/path/in/workspace", content: "complete file content", mode: "0644" }],
    commands: [{ command: "optional shell command", purpose: "why", timeoutSeconds: 120 }],
    openIssues: ["remaining risks or blockers"],
  };
  return [
    "You are the Worker of a local mission orchestration runtime.",
    "Return ONLY one strict JSON object. Do not use markdown fences unless unavoidable.",
    "Your JSON may write files under the workspace. Never use absolute paths, '..', or .git paths.",
    "Commands are optional and may be skipped unless the runtime explicitly allows model commands.",
    "The validator, not you, decides final acceptance. Provide concrete evidence-oriented output.",
    "# Required JSON schema",
    JSON.stringify(schema, null, 2),
    "# Mission",
    missionMd.slice(0, 12000),
    "# Runtime state",
    JSON.stringify(
      {
        missionId: state.missionId,
        phase: state.phase,
        status: state.status,
        resumeFrom: state.resumeFrom,
        workingDirectory: state.workingDirectory,
      },
      null,
      2,
    ),
    "# Current step",
    JSON.stringify(step, null, 2),
    "# Retry context",
    JSON.stringify(retry, null, 2),
  ].join("\n");
}

function extractJsonObject(text: string): Record<string, any> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const candidates = fenced ? [fenced[1], trimmed] : [trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // fall through
    }
    for (let start = 0; start < candidate.length; start += 1) {
      if (candidate[start] !== "{") {
        continue;
      }
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let end = start; end < candidate.length; end += 1) {
        const char = candidate[end];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === "\"") {
            inString = false;
          }
          continue;
        }
        if (char === "\"") {
          inString = true;
          continue;
        }
        if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            try {
              const parsed = JSON.parse(candidate.slice(start, end + 1));
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
              }
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  return null;
}

function nextQuestionStepId(features: any): string {
  const existing = new Set((features.steps || []).map((entry: any) => entry.stepId));
  let index = 1;
  while (true) {
    const candidate = `step-ask-${String(index).padStart(3, "0")}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function syncPlanQuestions(features: any, planStepId: string, payload: any): string[] {
  const questions = Array.isArray(payload?.questions)
    ? payload.questions.filter(
        (entry: any) => entry && typeof entry === "object" && String(entry.question || "").trim(),
      )
    : [];
  const steps = features.steps || (features.steps = []);
  const generatedIds = new Set(
    steps.filter((entry: any) => entry.generatedByStepId === planStepId).map((entry: any) => entry.stepId),
  );

  if (generatedIds.size) {
    features.steps = steps.filter((entry: any) => !generatedIds.has(entry.stepId));
    for (const step of features.steps) {
      if (!Array.isArray(step.dependsOn)) {
        continue;
      }
      step.dependsOn = step.dependsOn.map((dependency: string) => (generatedIds.has(dependency) ? planStepId : dependency));
    }
  }

  if (!questions.length) {
    return [];
  }

  const downstream = (features.steps || []).filter(
    (entry: any) => entry.stepId !== planStepId && (entry.dependsOn || []).includes(planStepId),
  );
  const insertedIds: string[] = [];
  let previous = planStepId;
  for (const entry of questions) {
    const stepId = nextQuestionStepId(features);
    insertedIds.push(stepId);
    features.steps.push({
      stepId,
      title: `Ask user: ${String(entry.question).slice(0, 72)}`,
      objective: entry.reason || entry.question,
      type: "ask_user",
      status: "pending",
      owner: "orchestrator",
      attemptCount: 0,
      retryBudget: 1,
      dependsOn: [previous],
      question: String(entry.question).trim(),
      reason: entry.reason ? String(entry.reason).trim() : "",
      generatedByStepId: planStepId,
    });
    previous = stepId;
  }

  for (const step of downstream) {
    const dependencies = Array.isArray(step.dependsOn) ? [...step.dependsOn] : [];
    step.dependsOn = dependencies.map((dependency: string) => (dependency === planStepId ? previous : dependency));
  }

  return insertedIds;
}

function workspaceTarget(workspaceDir: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`unsafe path: ${JSON.stringify(relativePath)}`);
  }
  const parts = relativePath.split(/[\\/]+/);
  if (parts.includes("..") || parts.includes(".git")) {
    throw new Error(`unsafe path: ${JSON.stringify(relativePath)}`);
  }
  const target = path.resolve(workspaceDir, relativePath);
  const relative = path.relative(path.resolve(workspaceDir), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes workspace: ${JSON.stringify(relativePath)}`);
  }
  return target;
}

function writeCommandEvidence(missionDir: string, prefix: string, result: any): string[] {
  const base = path.join(missionDir, "evidence", prefix);
  const stdoutPath = `${base}.stdout.txt`;
  const stderrPath = `${base}.stderr.txt`;
  const jsonPath = `${base}.json`;
  fs.writeFileSync(stdoutPath, result.stdout || "", "utf8");
  fs.writeFileSync(stderrPath, result.stderr || "", "utf8");
  writeJson(jsonPath, result);
  return [stdoutPath, stderrPath, jsonPath].map((entry) => path.relative(missionDir, entry));
}

async function applyLlmWorkerJson(
  missionDir: string,
  workspaceDir: string,
  attemptId: string,
  payload: any,
  step: any,
): Promise<Record<string, any>> {
  const refs: string[] = [];
  const actions: Record<string, any>[] = [];
  const issues: string[] = [];
  let failureClass: string | null = null;
  const allowCommands = Boolean(step.allowModelCommands);

  for (const [index, fileEntry] of (payload.files || []).entries()) {
    if (!fileEntry || typeof fileEntry !== "object") {
      issues.push(`file[${index}] is not an object`);
      failureClass ||= "invalid_worker_output";
      continue;
    }
    const relativePath = String(fileEntry.path || "");
    try {
      const target = workspaceTarget(workspaceDir, relativePath);
      ensureDir(path.dirname(target));
      const content = String(fileEntry.content || "");
      fs.writeFileSync(target, content, "utf8");
      if (fileEntry.mode) {
        try {
          fs.chmodSync(target, Number.parseInt(String(fileEntry.mode), 8));
        } catch (error) {
          issues.push(`chmod skipped for ${relativePath}: ${error}`);
        }
      }
      const meta = { kind: "file_write", path: relativePath, bytes: Buffer.byteLength(content, "utf8") };
      actions.push(meta);
      const evidencePath = path.join(missionDir, "evidence", `${attemptId}-file-${index + 1}.json`);
      writeJson(evidencePath, meta);
      refs.push(path.relative(missionDir, evidencePath));
    } catch (error) {
      issues.push(String(error));
      failureClass ||= "unsafe_file_operation";
    }
  }

  for (const [index, commandEntry] of (payload.commands || []).entries()) {
    const command = typeof commandEntry === "object" ? commandEntry.command : String(commandEntry || "");
    if (!command) {
      continue;
    }
    if (!allowCommands) {
      actions.push({ kind: "model_command_skipped", command, reason: "allowModelCommands=false" });
      continue;
    }
    const timeoutSeconds =
      typeof commandEntry === "object" ? Number(commandEntry.timeoutSeconds || 600) : 600;
    const result = await runShell(command, workspaceDir, timeoutSeconds);
    refs.push(...writeCommandEvidence(missionDir, `${attemptId}-model-command-${index + 1}`, result));
    actions.push({ kind: "model_command", command, exitCode: result.exitCode });
    if (result.exitCode !== 0) {
      failureClass = result.timedOut ? "environment_error" : "tool_error";
      issues.push(`model command failed: ${command} exit=${result.exitCode}`);
    }
  }

  let claimedStatus = String(payload.status || "succeeded").toLowerCase();
  if (!["succeeded", "partial", "failed", "blocked"].includes(claimedStatus)) {
    claimedStatus = "partial";
  }

  let status = "succeeded";
  if (failureClass) {
    status = "failed";
  } else if (claimedStatus === "failed" || claimedStatus === "blocked") {
    status = claimedStatus === "blocked" ? "blocked" : "failed";
    failureClass = claimedStatus;
  } else if (claimedStatus === "partial") {
    status = "partial";
  }

  return {
    status,
    actions,
    artifactRefs: refs,
    summary: shortText(String(payload.summary || "LLM worker produced structured output"), 1500),
    openIssues: [...(payload.openIssues || []), ...issues],
    failureClass,
  };
}

async function gitSummary(workspaceDir: string): Promise<Record<string, any>> {
  if (!fs.existsSync(path.join(workspaceDir, ".git"))) {
    return { isGitRepo: false };
  }
  const statusShort = await runShell("git status --short", workspaceDir, 30);
  const diffStat = await runShell("git diff --stat", workspaceDir, 30);
  return {
    isGitRepo: true,
    statusShort: statusShort.stdout,
    diffStat: diffStat.stdout,
  };
}

async function executeWorker(missionDir: string, step: any, state: any, features?: any): Promise<Record<string, any>> {
  const attemptId = mid("attempt");
  const workspaceDir = path.resolve(expandHome(state.workingDirectory || "."));
  const pauseFile = path.join(missionDir, "pause.requested");
  const refs: string[] = [];
  const actions: Record<string, any>[] = [];
  let status = "failed";
  let failureClass: string | null = null;
  let failureDetail = "";
  let summary = "";
  const issues: string[] = [];
  const missionMdPath = path.join(missionDir, "mission.md");
  const missionMd = fs.existsSync(missionMdPath) ? fs.readFileSync(missionMdPath, "utf8") : "";

  try {
    const type = step.type || "llm_worker";
    if (type === "shell" || type === "exec") {
      const result = await runShell(step.command || "", workspaceDir, Number(step.timeoutSeconds || 600), pauseFile);
      refs.push(...writeCommandEvidence(missionDir, `${attemptId}-worker`, result));
      actions.push({ kind: "shell", command: step.command, exitCode: result.exitCode });
      if (result.paused) {
        status = "paused";
        failureClass = "pause_requested";
        summary = "Worker paused by operator request";
      } else if (result.exitCode === 0) {
        status = "succeeded";
        summary = `Command exited 0: ${step.command}`;
      } else {
        failureClass = result.timedOut ? "environment_error" : "tool_error";
        failureDetail = `Command exited ${result.exitCode}`;
        summary = failureDetail;
        issues.push(failureDetail);
      }
    } else if (["external_cli", "claude_code", "codex"].includes(type)) {
      const prompt = workerPrompt(state, step, missionMd, {
        attemptCount: step.attemptCount || 0,
        previousFailureClass: step.failureClass,
      });
      const promptPath = path.join(missionDir, "evidence", `${attemptId}-prompt.md`);
      fs.writeFileSync(promptPath, prompt, "utf8");
      refs.push(path.relative(missionDir, promptPath));
      const command = formatTemplate(step.commandTemplate || step.command || "", {
        prompt_file: shellQuote(promptPath),
        prompt: shellQuote(prompt),
        raw_prompt: prompt,
        workspace: shellQuote(workspaceDir),
        mission_dir: shellQuote(missionDir),
      });
      const result = await runShell(command, workspaceDir, Number(step.timeoutSeconds || 1800), pauseFile);
      refs.push(...writeCommandEvidence(missionDir, `${attemptId}-external-cli`, result));
      actions.push({
        kind: "external_cli",
        commandTemplate: step.commandTemplate || step.command,
        exitCode: result.exitCode,
      });
      if (result.paused) {
        status = "paused";
        failureClass = "pause_requested";
        summary = "External CLI worker paused by operator request";
      } else if (result.exitCode === 0) {
        status = "succeeded";
        summary = shortText(result.stdout || "External CLI completed", 1500);
      } else {
        failureClass = result.timedOut ? "environment_error" : "tool_error";
        failureDetail = `External CLI exited ${result.exitCode}`;
        summary = failureDetail;
        issues.push(shortText(result.stderr || result.stdout, 1200));
      }
    } else if (["llm_worker", "model_patch", "model"].includes(type)) {
      const prompt = llmWorkerPrompt(state, step, missionMd, {
        attemptCount: step.attemptCount || 0,
        previousFailureClass: step.failureClass,
      });
      const response = await callAdapter(missionDir, step.adapterRef || step.adapterId, prompt, "worker");
      const rawPath = path.join(missionDir, "evidence", `${attemptId}-model-output.md`);
      fs.writeFileSync(rawPath, response.content, "utf8");
      refs.push(path.relative(missionDir, rawPath));
      actions.push({
        kind: "model_call",
        adapterId: response.adapterId,
        model: response.model,
        workerMode: "json_delta",
      });
      const payload = extractJsonObject(response.content);
      if (!payload) {
        failureClass = "invalid_worker_output";
        failureDetail = "model did not return a JSON object";
        summary = failureDetail;
        issues.push(failureDetail);
        status = "failed";
      } else {
        const parsedPath = path.join(missionDir, "evidence", `${attemptId}-model-json.json`);
        writeJson(parsedPath, payload);
        refs.push(path.relative(missionDir, parsedPath));
        const applied = await applyLlmWorkerJson(missionDir, workspaceDir, attemptId, payload, step);
        refs.push(...applied.artifactRefs);
        actions.push(...applied.actions);
        status = applied.status;
        failureClass = applied.failureClass;
        summary = applied.summary;
        issues.push(...applied.openIssues);
        if (status === "partial" && !failureClass) {
          failureClass = "partial_completion";
        }
      }
    } else if (type === "model_plan") {
      const prompt = modelPlanPrompt(state, step, missionMd, {
        attemptCount: step.attemptCount || 0,
        previousFailureClass: step.failureClass,
      });
      let response: Record<string, any>;
      if (step.commandTemplate || step.command) {
        const promptPath = path.join(missionDir, "evidence", `${attemptId}-plan-prompt.md`);
        fs.writeFileSync(promptPath, prompt, "utf8");
        refs.push(path.relative(missionDir, promptPath));
        const command = formatTemplate(step.commandTemplate || step.command || "", {
          prompt_file: shellQuote(promptPath),
          prompt: shellQuote(prompt),
          raw_prompt: prompt,
          workspace: shellQuote(workspaceDir),
          mission_dir: shellQuote(missionDir),
        });
        const result = await runShell(command, workspaceDir, Number(step.timeoutSeconds || 1800), pauseFile);
        refs.push(...writeCommandEvidence(missionDir, `${attemptId}-model-plan`, result));
        actions.push({
          kind: "external_cli_plan",
          commandTemplate: step.commandTemplate || step.command,
          exitCode: result.exitCode,
        });
        if (result.paused) {
          status = "paused";
          failureClass = "pause_requested";
          summary = "Planning paused by operator request";
          response = { content: "" };
        } else if (result.exitCode === 0) {
          response = { content: result.stdout || result.stderr || "Planner completed successfully." };
        } else {
          throw new Error(`${result.timedOut ? "environment_error" : "tool_error"}:planner exited ${result.exitCode}`);
        }
      } else {
        response = await callAdapter(
          missionDir,
          step.adapterRef || step.adapterId,
          prompt,
          "orchestrator",
        );
        actions.push({
          kind: "model_call",
          adapterId: response.adapterId,
          model: response.model,
          workerMode: "plan_only",
        });
      }

      if (status !== "paused") {
        const evidencePath = path.join(missionDir, "evidence", `${attemptId}-model-plan.md`);
        fs.writeFileSync(evidencePath, response.content || "", "utf8");
        refs.push(path.relative(missionDir, evidencePath));
        if ((response.content || "").trim()) {
          const payload = extractJsonObject(response.content || "");
          if (payload) {
            const parsedPath = path.join(missionDir, "evidence", `${attemptId}-model-plan.json`);
            writeJson(parsedPath, payload);
            refs.push(path.relative(missionDir, parsedPath));
            if (features) {
              const insertedQuestions = syncPlanQuestions(features, step.stepId, payload);
              if (insertedQuestions.length) {
                actions.push({ kind: "plan_questions", stepIds: insertedQuestions });
              }
            }
            summary = shortText(String(payload.summary || response.content), 1500);
          } else {
            summary = shortText(response.content, 1500);
          }
          status = "succeeded";
        } else {
          failureClass = "no_effect_change";
          failureDetail = "empty model response";
          summary = failureDetail;
          issues.push(failureDetail);
        }
      }
    } else if (type === "ask_user") {
      const question = String(step.question || "").trim();
      const answer = String(step.answer || "").trim();
      if (!question) {
        failureClass = "invalid_worker_output";
        failureDetail = "missing ask_user question";
        summary = failureDetail;
        issues.push(failureDetail);
      } else if (!answer) {
        failureClass = "needs_user_input";
        failureDetail = question;
        summary = question;
      } else {
        const evidencePath = path.join(missionDir, "evidence", `${attemptId}-ask-user.json`);
        writeJson(evidencePath, {
          stepId: step.stepId,
          question,
          reason: step.reason || "",
          answer,
          answeredAt: step.answeredAt || now(),
        });
        refs.push(path.relative(missionDir, evidencePath));
        actions.push({ kind: "ask_user_answer", question, answer });
        status = "succeeded";
        summary = `User answered: ${shortText(answer, 400)}`;
      }
    } else if (type === "noop" || type === "manual") {
      const evidencePath = path.join(missionDir, "evidence", `${attemptId}-noop.txt`);
      fs.writeFileSync(evidencePath, step.note || "No-op worker recorded", "utf8");
      refs.push(path.relative(missionDir, evidencePath));
      actions.push({ kind: "noop" });
      status = "succeeded";
      summary = "No-op worker recorded";
    } else {
      throw new Error(`unsupported step type ${type}`);
    }
  } catch (error) {
    failureClass = errorCategory(error);
    failureDetail = shortText(error instanceof Error ? error.message : String(error));
    summary = failureDetail;
    issues.push(failureDetail);
  }

  const attempt = {
    attemptId,
    stepId: step.stepId,
    intent: step.objective || step.title,
    strategy:
      step.strategy ||
      (["llm_worker", "model_patch", "model"].includes(step.type) ? "llm_json_delta" : "default"),
    adapterRef: step.adapterRef || roleAdapterId(missionDir, "worker"),
    status,
    startedAt: now(),
    endedAt: now(),
    actionsTaken: actions,
    artifactRefs: refs,
    toolSummary: actions,
    outputSummary: summary,
    diffSummary: await gitSummary(workspaceDir),
    validatorOutcome: null,
    failureClass,
    failureDetail,
    claimedOutcome: status === "succeeded" ? summary : "",
    openIssues: issues,
    nextRecommendation: status === "succeeded" ? "validator_review" : "retry_with_changed_strategy",
  };

  appendJsonl(path.join(missionDir, "attempts.jsonl"), attempt);
  appendJsonl(path.join(missionDir, "worker-transcripts.jsonl"), {
    ts: now(),
    kind: "worker_attempt",
    attemptId,
    stepId: step.stepId,
    status,
    summary,
  });
  return attempt;
}

function handoff(missionDir: string, attempt: any, step: any): any {
  const handoffCount = fs.readdirSync(path.join(missionDir, "handoffs")).filter((name) => name.endsWith(".json")).length + 1;
  const data = {
    handoffId: `handoff-${String(handoffCount).padStart(4, "0")}`,
    attemptId: attempt.attemptId,
    stepId: step.stepId,
    createdAt: now(),
    successState:
      attempt.status === "succeeded" ? "success" : attempt.status === "partial" ? "partial" : "failure",
    returnToOrchestrator: true,
    commitId: null,
    validatorsPassed: false,
    salientSummary: attempt.outputSummary,
    whatWasImplemented: attempt.claimedOutcome,
    whatWasLeftUndone: attempt.openIssues || [],
    verification: {
      commands: (attempt.actionsTaken || []).filter((entry: any) => Object.prototype.hasOwnProperty.call(entry, "exitCode")),
      observations: attempt.outputSummary,
    },
    discoveredIssues: attempt.openIssues || [],
    artifactRefs: attempt.artifactRefs || [],
  };
  writeJson(
    path.join(missionDir, "handoffs", `${String(handoffCount).padStart(4, "0")}-${attempt.attemptId}.json`),
    data,
  );
  return data;
}

function checksFor(step: any, state: any): any[] {
  const checks = [];
  for (const [index, entry] of (step.checks || []).entries()) {
    checks.push({
      name: `check-${index + 1}`,
      kind: "command",
      required: true,
      ...(typeof entry === "object" ? entry : { command: entry }),
    });
  }
  if (step.validateCommand) {
    checks.push({
      name: "step-validate-command",
      kind: "command",
      command: step.validateCommand,
      required: true,
    });
  }
  if (step.type === "acceptance" && !checks.length) {
    return state.acceptancePolicy?.checks || [];
  }
  return checks;
}

async function validateStep(missionDir: string, step: any, attempt: any, state: any): Promise<any> {
  const validationId = mid("validation");
  const workspaceDir = path.resolve(expandHome(state.workingDirectory || "."));
  const checks = checksFor(step, state);
  const evidenceRefs: string[] = [];
  const checkResults: any[] = [];

  let result =
    attempt.status === "succeeded" && ((attempt.artifactRefs || []).length || checks.length)
      ? "pass"
      : attempt.failureClass === "environment_error"
        ? "environment_error"
        : attempt.status !== "succeeded"
          ? "fail"
          : "insufficient_evidence";
  let failureClass = result === "pass" ? null : attempt.failureClass || result;
  let summary = "Worker produced evidence.";

  for (const check of checks) {
    if (check.kind !== "command" || !check.command) {
      checkResults.push({
        name: check.name,
        status: "skipped",
        reason: "unsupported_or_missing_command",
      });
      if (check.required !== false) {
        result = "requires_human";
        failureClass = "unsupported_check";
        summary = "Required check unsupported or missing";
      }
      continue;
    }
    const runResult = await runShell(check.command, workspaceDir, Number(check.timeoutSeconds || 600));
    const refs = writeCommandEvidence(missionDir, `${validationId}-${check.name || "check"}`, runResult);
    evidenceRefs.push(...refs);
    const passed = runResult.exitCode === 0;
    checkResults.push({
      name: check.name,
      kind: "command",
      command: check.command,
      required: check.required !== false,
      status: passed ? "passed" : "failed",
      exitCode: runResult.exitCode,
      evidenceRefs: refs,
    });
    if (check.required !== false && !passed) {
      result = runResult.timedOut ? "environment_error" : "fail";
      failureClass = runResult.timedOut ? "environment_error" : "validation_failed";
      summary = `Required check failed: ${check.name}`;
    }
  }

  if (
    checks.length &&
    attempt.status === "succeeded" &&
    checkResults.filter((entry) => entry.required !== false).every((entry) => entry.status === "passed")
  ) {
    result = "pass";
    failureClass = null;
    summary = "All required validation checks passed.";
  }

  const recommendedAction =
    result === "pass"
      ? "continue"
      : result === "fail"
        ? "fix_first"
        : result === "requires_human" || result === "environment_error"
          ? "escalate"
          : "collect_evidence";

  const validation = {
    validationId,
    scope: step.type === "acceptance" ? "mission" : "step",
    targetId: step.stepId,
    workerResultRef: attempt.attemptId,
    createdAt: now(),
    result,
    checks,
    checkResults,
    evidenceRefs: evidenceRefs.length ? evidenceRefs : attempt.artifactRefs || [],
    validationSummary: summary,
    summary,
    failureClass,
    reasoningSummary: summary,
    recommendedAction,
    canRetrySameStrategy: false,
  };

  writeJson(path.join(missionDir, "evidence", `${validationId}.json`), validation);
  appendJsonl(path.join(missionDir, "validation_log.jsonl"), validation);
  const validationState = missionValidationState(missionDir);
  validationState.assertions ||= {};
  validationState.assertions[step.stepId] = {
    status: result,
    validationId,
    updatedAt: now(),
    summary,
    failureClass,
    evidenceRefs: validation.evidenceRefs,
  };
  if (validation.scope === "mission") {
    validationState.mission ||= {};
    validationState.mission.acceptance = {
      status: result,
      validationId,
      updatedAt: now(),
      summary,
    };
  }
  writeJson(path.join(missionDir, "validation-state.json"), validationState);
  return validation;
}

function dependenciesPassed(steps: any[], step: any): boolean {
  return (step.dependsOn || []).every((dependency: string) => {
    const match = steps.find((candidate: any) => candidate.stepId === dependency);
    return (match?.status || "passed") === "passed";
  });
}

function runnableSteps(features: any): any[] {
  const steps = features.steps || [];
  return steps.filter(
    (step: any) =>
      step.type !== "acceptance" &&
      ["pending", "failed", "needs_validation", "waiting_user"].includes(step.status || "pending") &&
      dependenciesPassed(steps, step) &&
      Number(step.attemptCount || 0) < Number(step.retryBudget || 1),
  );
}

function nextQuestionStep(features: any): any | null {
  return (
    runnableSteps(features).find((step: any) => step.type === "ask_user" && !String(step.answer || "").trim()) || null
  );
}

function syncActiveStepState(state: any): void {
  state.activeStepIds = Array.isArray(state.activeStepIds) ? [...new Set(state.activeStepIds.filter(Boolean))] : [];
  if (state.activeStepIds.length) {
    state.currentStepId = state.activeStepIds[state.activeStepIds.length - 1];
  } else if (state.phase === "executing" && state.status === "active") {
    state.currentStepId = null;
  }
}

function allCorePassed(features: any): boolean {
  const coreSteps = (features.steps || []).filter((step: any) => step.type !== "acceptance");
  return Boolean(coreSteps.length) && coreSteps.every((step: any) => ["passed", "skipped"].includes(step.status));
}

async function executeScheduledStep(
  missionDir: string,
  step: any,
  state: any,
  features: any,
): Promise<Record<string, any>> {
  step.status = "in_progress";
  step.startedAt ||= now();
  state.activeStepIds = Array.isArray(state.activeStepIds) ? state.activeStepIds : [];
  state.activeStepIds.push(step.stepId);
  state.resumeFrom = step.stepId;
  state.phase = "executing";
  syncActiveStepState(state);
  writeJson(path.join(missionDir, "state.json"), state);
  writeJson(path.join(missionDir, "features.json"), features);
  event(missionDir, "worker_selected_feature", {
    stepId: step.stepId,
    title: step.title,
    type: step.type,
  });
  event(missionDir, "worker_started", { stepId: step.stepId });

  try {
    const attempt = await executeWorker(missionDir, step, state, features);
    const handoffRecord = handoff(missionDir, attempt, step);
    state.latestAttemptId = attempt.attemptId;
    state.lastReviewedHandoffCount = fs
      .readdirSync(path.join(missionDir, "handoffs"))
      .filter((name) => name.endsWith(".json")).length;
    writeJson(path.join(missionDir, "state.json"), state);

    if (attempt.status === "paused") {
      event(missionDir, "worker_paused", { stepId: step.stepId, attemptId: attempt.attemptId });
      step.status = "pending";
      writeJson(path.join(missionDir, "features.json"), features);
      return { stepId: step.stepId, status: "paused" };
    }

    step.attemptCount = Number(step.attemptCount || 0) + 1;
    if (attempt.status !== "succeeded") {
      event(missionDir, "worker_failed", {
        stepId: step.stepId,
        attemptId: attempt.attemptId,
        reason: attempt.failureClass,
        detail: attempt.failureDetail,
      });
      step.status = "failed";
      step.failureClass = attempt.failureClass;
      step.failureDetail = attempt.failureDetail;
      writeJson(path.join(missionDir, "features.json"), features);
      if (step.attemptCount >= Number(step.retryBudget || 1)) {
        return { stepId: step.stepId, status: "escalated", reason: "retry_exhausted" };
      }
      event(missionDir, "fix_first_queue_reordered", {
        message: "Reordered the queue after worker failure. Continue mission execution with fix-first sequencing.",
        stepId: step.stepId,
      });
      return {
        stepId: step.stepId,
        status: "retryable_failure",
        ranStep: { stepId: step.stepId, workerStatus: attempt.status },
      };
    }

    event(missionDir, "worker_completed", {
      stepId: step.stepId,
      attemptId: attempt.attemptId,
      handoffId: handoffRecord.handoffId,
    });
    step.status = "needs_validation";
    writeJson(path.join(missionDir, "features.json"), features);
    event(missionDir, "milestone_validation_triggered", {
      stepId: step.stepId,
      attemptId: attempt.attemptId,
    });
    state.phase = "validating";
    writeJson(path.join(missionDir, "state.json"), state);

    const validation = await validateStep(missionDir, step, attempt, state);
    state.latestValidationId = validation.validationId;
    state.phase = "executing";
    writeJson(path.join(missionDir, "state.json"), state);
    event(missionDir, "validator_completed", {
      stepId: step.stepId,
      validationId: validation.validationId,
      result: validation.result,
      recommendedAction: validation.recommendedAction,
    });

    if (validation.result === "pass") {
      step.status = "passed";
      step.failureClass = null;
      step.failureDetail = null;
      step.passedAt = now();
      writeJson(path.join(missionDir, "features.json"), features);
      return {
        stepId: step.stepId,
        status: "passed",
        ranStep: {
          stepId: step.stepId,
          attemptId: attempt.attemptId,
          workerStatus: attempt.status,
          validation: "pass",
        },
      };
    }

    step.status = "failed";
    step.failureClass = validation.failureClass;
    step.failureDetail = validation.summary;
    step.requiredStrategyChange = validation.recommendedAction;
    writeJson(path.join(missionDir, "features.json"), features);
    if (validation.recommendedAction === "fix_first" && step.attemptCount < Number(step.retryBudget || 1)) {
      event(missionDir, "fix_first_queue_reordered", {
        message: "Reordered the queue after validation failure. Continue mission execution with fix-first sequencing.",
        stepId: step.stepId,
      });
      return {
        stepId: step.stepId,
        status: "retryable_failure",
        ranStep: {
          stepId: step.stepId,
          attemptId: attempt.attemptId,
          workerStatus: attempt.status,
          validation: validation.result,
        },
      };
    }
    return { stepId: step.stepId, status: "escalated", reason: validation.result };
  } finally {
    state.activeStepIds = (state.activeStepIds || []).filter((entry: string) => entry !== step.stepId);
    syncActiveStepState(state);
    writeJson(path.join(missionDir, "state.json"), state);
    writeJson(path.join(missionDir, "features.json"), features);
  }
}

export async function runMission(
  missionDir: string,
  maxSteps = 10,
  resume = false,
  allowStaleLock = false,
  maxParallel = 4,
): Promise<Record<string, any>> {
  layout(missionDir);
  const lockMessage = acquireLock(missionDir, allowStaleLock);
  if (lockMessage) {
    return { ok: false, status: "locked", message: lockMessage };
  }
  const ranSteps: any[] = [];
  try {
    let state = missionState(missionDir);
    if (resume) {
      fs.rmSync(path.join(missionDir, "pause.requested"), { force: true });
      state.pauseRequested = false;
      event(missionDir, "mission_resumed", {
        resumeWorkerSessionId: state.latestAttemptId,
        resumeFrom: state.resumeFrom,
      });
    }
    event(missionDir, "mission_run_started", {
      message: "Starting or continuing mission execution",
      resume,
      maxParallel,
    });
    state.state = "active";
    state.status = "active";
    state.phase = "executing";
    state.activeStepIds = Array.isArray(state.activeStepIds) ? state.activeStepIds : [];
    state.maxParallel = maxParallel;
    syncActiveStepState(state);
    writeJson(path.join(missionDir, "state.json"), state);

    const features = missionFeatures(missionDir);
    const running = new Map<string, Promise<Record<string, any>>>();
    let launchedSteps = 0;
    let pauseOutcome: Record<string, any> | null = null;
    let escalationOutcome: Record<string, any> | null = null;

    while (true) {
      state.activeStepIds = Array.isArray(state.activeStepIds) ? state.activeStepIds : [];
      state.maxParallel = maxParallel;
      writeJson(path.join(missionDir, "state.json"), state);

      if ((fs.existsSync(path.join(missionDir, "pause.requested")) || state.pauseRequested) && !running.size) {
        event(missionDir, "worker_paused", {
          stepId: state.currentStepId,
          attemptId: state.latestAttemptId,
        });
        state.pauseRequested = false;
        state.state = "paused";
        state.status = "paused";
        state.phase = "paused";
        state.resumeFrom = state.currentStepId;
        writeJson(path.join(missionDir, "state.json"), state);
        event(missionDir, "mission_paused", { resumeFrom: state.resumeFrom });
        return { ok: true, status: "paused", ranSteps };
      }

      const blockingQuestion = nextQuestionStep(features);
      if (blockingQuestion && !running.size) {
        state.currentStepId = blockingQuestion.stepId;
        state.resumeFrom = blockingQuestion.stepId;
        state.state = "waiting_user";
        state.status = "waiting_user";
        state.phase = "question";
        blockingQuestion.status = "waiting_user";
        syncActiveStepState(state);
        writeJson(path.join(missionDir, "features.json"), features);
        writeJson(path.join(missionDir, "state.json"), state);
        event(missionDir, "mission_question_requested", {
          stepId: blockingQuestion.stepId,
          question: blockingQuestion.question || "",
          reason: blockingQuestion.reason || "",
        });
        return {
          ok: false,
          status: "waiting_user",
          stepId: blockingQuestion.stepId,
          question: blockingQuestion.question || "",
          reason: blockingQuestion.reason || "",
          ranSteps,
        };
      }

      if (!running.size && escalationOutcome) {
        state.state = "escalated";
        state.status = "waiting_human";
        state.phase = "escalated";
        state.latestEscalationReason = escalationOutcome.reason;
        syncActiveStepState(state);
        writeJson(path.join(missionDir, "state.json"), state);
        event(missionDir, "mission_escalated", {
          stepId: escalationOutcome.stepId,
          reason: escalationOutcome.reason,
        });
        return { ok: false, status: "escalated", ranSteps };
      }

      if (!running.size && allCorePassed(features)) {
        state.state = "ready";
        state.status = "active";
        state.phase = "ready_for_acceptance";
        state.resumeFrom = "accept";
        syncActiveStepState(state);
        writeJson(path.join(missionDir, "state.json"), state);
        event(missionDir, "mission_ready_for_acceptance");
        return { ok: true, status: "ready_for_acceptance", ranSteps };
      }

      const pauseRequested = fs.existsSync(path.join(missionDir, "pause.requested")) || state.pauseRequested;
      const shouldSchedule = !pauseRequested && !blockingQuestion && !escalationOutcome;
      while (shouldSchedule && running.size < maxParallel && launchedSteps < maxSteps) {
        const runnable = runnableSteps(features).filter((step: any) => !running.has(step.stepId));
        const next = runnable.find((step: any) => !(step.type === "ask_user" && !String(step.answer || "").trim()));
        if (!next) {
          break;
        }
        launchedSteps += 1;
        running.set(next.stepId, executeScheduledStep(missionDir, next, state, features));
      }

      if (!running.size) {
        if (launchedSteps >= maxSteps) {
          return { ok: true, status: "max_steps_reached", ranSteps };
        }
        if (allCorePassed(features)) {
          state.state = "ready";
          state.status = "active";
          state.phase = "ready_for_acceptance";
          state.resumeFrom = "accept";
          syncActiveStepState(state);
          writeJson(path.join(missionDir, "state.json"), state);
          event(missionDir, "mission_ready_for_acceptance");
          return { ok: true, status: "ready_for_acceptance", ranSteps };
        }
        state.state = "blocked";
        state.status = "blocked";
        state.phase = "blocked";
        syncActiveStepState(state);
        writeJson(path.join(missionDir, "state.json"), state);
        return { ok: false, status: "blocked", message: "No runnable step found", ranSteps };
      }

      const settled = await Promise.race(
        [...running.entries()].map(async ([stepId, promise]) => ({ stepId, result: await promise })),
      );
      running.delete(settled.stepId);

      if (settled.result.ranStep) {
        ranSteps.push(settled.result.ranStep);
      }
      if (settled.result.status === "paused") {
        pauseOutcome = settled.result;
      }
      if (settled.result.status === "escalated" && !escalationOutcome) {
        escalationOutcome = settled.result;
      }
      if (pauseOutcome && !running.size) {
        state.pauseRequested = false;
        state.state = "paused";
        state.status = "paused";
        state.phase = "paused";
        state.resumeFrom = pauseOutcome.stepId || state.resumeFrom;
        syncActiveStepState(state);
        writeJson(path.join(missionDir, "state.json"), state);
        event(missionDir, "mission_paused", { resumeFrom: state.resumeFrom });
        return { ok: true, status: "paused", ranSteps };
      }
    }
  } finally {
    releaseLock(missionDir);
  }
}

export async function acceptMission(missionDir: string): Promise<Record<string, any>> {
  const state = missionState(missionDir);
  const features = missionFeatures(missionDir);
  let step = (features.steps || []).find((entry: any) => entry.type === "acceptance");
  if (!step) {
    step = {
      stepId: "acceptance",
      title: "Mission acceptance",
      type: "acceptance",
      status: "pending",
      attemptCount: 0,
      retryBudget: 1,
      checks: state.acceptancePolicy?.checks || [],
    };
    features.steps ||= [];
    features.steps.push(step);
  }
  const attempt = {
    attemptId: mid("acceptance"),
    stepId: step.stepId,
    status: "succeeded",
    artifactRefs: [],
    outputSummary: "Acceptance validation requested",
    failureClass: null,
  };
  event(missionDir, "milestone_validation_triggered", {
    stepId: step.stepId,
    attemptId: attempt.attemptId,
    acceptance: true,
  });
  const validation = await validateStep(missionDir, step, attempt, state);
  state.latestValidationId = validation.validationId;
  state.state = validation.result === "pass" ? "accepted" : "blocked";
  state.status = validation.result === "pass" ? "accepted" : "blocked";
  state.phase = validation.result === "pass" ? "accepted" : "accepting";
  state.resumeFrom = validation.result === "pass" ? null : "accept";
  writeJson(path.join(missionDir, "state.json"), state);
  step.status = validation.result === "pass" ? "passed" : "failed";
  step.attemptCount = Number(step.attemptCount || 0) + 1;
  writeJson(path.join(missionDir, "features.json"), features);
  event(missionDir, "acceptance_completed", {
    validationId: validation.validationId,
    result: validation.result,
  });
  return { ok: validation.result === "pass", status: state.status, validation };
}

export function statusObject(missionDir: string): Record<string, any> {
  const state = missionState(missionDir);
  const features = missionFeatures(missionDir);
  const validationState = missionValidationState(missionDir);
  const currentStep = (features.steps || []).find((entry: any) => entry.stepId === state.currentStepId) || null;
  return redact({
    missionDir,
    missionId: state.missionId,
    name: state.name,
    state: state.state,
    phase: state.phase,
    status: state.status,
    workingDirectory: state.workingDirectory,
    currentStep,
    latestAttemptId: state.latestAttemptId,
    latestValidationId: state.latestValidationId,
    lastReviewedHandoffCount: state.lastReviewedHandoffCount,
    resumeFrom: state.resumeFrom,
    activeStepIds: state.activeStepIds || [],
    maxParallel: state.maxParallel || 4,
    steps: (features.steps || []).map((entry: any) => ({
      stepId: entry.stepId,
      title: entry.title,
      type: entry.type,
      status: entry.status,
      attemptCount: entry.attemptCount,
      retryBudget: entry.retryBudget,
      failureClass: entry.failureClass,
      failureDetail: entry.failureDetail,
      adapterRef: entry.adapterRef,
      question: entry.question,
      answer: entry.answer,
      reason: entry.reason,
    })),
    validationState,
    locked: fs.existsSync(path.join(missionDir, "run.lock")),
    pauseRequested: fs.existsSync(path.join(missionDir, "pause.requested")) || state.pauseRequested,
  });
}

export type InitOptions = Record<string, any>;

export function createMission(options: InitOptions): Record<string, any> {
  ensureDir(homeDir());
  const missionId = options.missionId || mid("mission");
  const missionDir = path.join(homeDir(), missionId);
  if (fs.existsSync(missionDir) && !options.force) {
    throw new Error(`Mission exists: ${missionDir}`);
  }
  layout(missionDir);
  const workspaceDir = path.resolve(expandHome(options.workspace || "."));
  ensureDir(workspaceDir);

  const acceptanceChecks = (options.accept || []).map((command: string, index: number) => ({
    name: `acceptance-${index + 1}`,
    kind: "command",
    command,
    required: true,
  }));
  const constraints = options.constraint || [];
  fs.writeFileSync(
    path.join(missionDir, "mission.md"),
    `# ${options.name}\n\n## Goal\n${options.goal}\n\n## Workspace\n${workspaceDir}\n\n## Constraints\n${
      (constraints.length ? constraints : ["none declared"]).map((entry: string) => `- ${entry}`).join("\n")
    }\n\n## Acceptance Checks\n${
      (acceptanceChecks.length
        ? acceptanceChecks
        : [{ command: "none declared" }]
      ).map((entry: any) => `- \`${entry.command}\``).join("\n")
    }\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(missionDir, "working_directory.txt"), workspaceDir, "utf8");

  const state = {
    version: 1,
    missionId,
    name: options.name,
    goal: options.goal,
    constraints,
    state: "initialized",
    phase: "planning",
    status: "active",
    workingDirectory: workspaceDir,
    workspacePath: workspaceDir,
    currentStepId: null,
    defaultAdapterRef: options.adapterId || null,
    acceptancePolicy: { checks: acceptanceChecks },
    latestAttemptId: null,
    latestValidationId: null,
    lastReviewedHandoffCount: 0,
    resumeFrom: "run",
    activeStepIds: [],
    maxParallel: 4,
    pauseRequested: false,
    createdAt: now(),
    updatedAt: now(),
  };
  const workerAdapterRef = options.workerAdapterId || null;
  const orchestratorAdapterRef = options.orchestratorAdapterId || null;
  writeJson(path.join(missionDir, "state.json"), state);

  const validationChecks = (options.validate || []).map((command: string, index: number) => ({
    name: `validate-${index + 1}`,
    kind: "command",
    command,
    required: true,
  }));

  const planFirst = options.planOnly
    ? true
    : options.planFirst ?? Boolean((options.workerCommand || options.adapterId) && !options.stepCommand);

  let workerStep: any = null;
  if (options.workerCommand) {
    workerStep = {
      stepId: "step-worker",
      title: "Run external CLI worker",
      objective: options.goal,
      type: "external_cli",
      commandTemplate: options.workerCommand,
      status: "pending",
      owner: "worker",
      attemptCount: 0,
      retryBudget: options.retryBudget,
      checks: validationChecks,
    };
    if (workerAdapterRef) {
      workerStep.adapterRef = workerAdapterRef;
    }
  } else if (options.stepCommand) {
    workerStep = {
      stepId: "step-shell",
      title: options.stepTitle || "Run shell worker command",
      objective: options.goal,
      type: "shell",
      command: options.stepCommand,
      status: "pending",
      owner: "worker",
      attemptCount: 0,
      retryBudget: options.retryBudget,
      checks: validationChecks,
    };
  } else {
    const defaultType = options.planOnly && options.adapterId ? "model_plan" : options.adapterId ? "llm_worker" : "noop";
    workerStep = {
      stepId: "step-worker",
      title: defaultType === "llm_worker" ? "Run LLM JSON worker" : "Create execution plan / handoff",
      objective: options.goal,
      type: defaultType,
      adapterRef: options.adapterId || null,
      status: "pending",
      owner: "worker",
      attemptCount: 0,
      retryBudget: options.retryBudget,
      checks: validationChecks,
      allowModelCommands: Boolean(options.allowModelCommands),
    };
    if (workerAdapterRef) {
      workerStep.adapterRef = workerAdapterRef;
    }
  }

  let planStep: any = null;
  if (planFirst && workerStep && workerStep.type !== "shell" && workerStep.type !== "noop") {
    planStep = {
      stepId: "step-plan",
      title: "Create execution plan",
      objective: `Plan how to execute: ${options.goal}`,
      type: "model_plan",
      status: "pending",
      owner: "orchestrator",
      attemptCount: 0,
      retryBudget: 1,
    };
    if (orchestratorAdapterRef) {
      planStep.adapterRef = orchestratorAdapterRef;
    }
    if (options.workerCommand) {
      planStep.commandTemplate = options.workerCommand;
    }
  }

  const steps = [];
  if (planStep) {
    steps.push(planStep);
  }
  if (!options.planOnly && workerStep) {
    if (planStep) {
      workerStep.dependsOn = [planStep.stepId];
    }
    steps.push(workerStep);
  } else if (!steps.length && workerStep) {
    steps.push(workerStep);
  }

  const acceptanceDependency = (!options.planOnly && workerStep?.stepId) || planStep?.stepId || workerStep?.stepId;
  if (acceptanceChecks.length) {
    steps.push({
      stepId: "step-acceptance",
      title: "Mission acceptance checks",
      objective: "Run final acceptance checks",
      type: "acceptance",
      status: "pending",
      owner: "validator",
      attemptCount: 0,
      retryBudget: 1,
      dependsOn: acceptanceDependency ? [acceptanceDependency] : [],
      checks: acceptanceChecks,
    });
  }

  writeJson(path.join(missionDir, "features.json"), {
    version: 1,
    missionId,
    steps,
    createdAt: now(),
    updatedAt: now(),
  });
  writeJson(path.join(missionDir, "validation-state.json"), {
    version: 1,
    missionId,
    assertions: Object.fromEntries(steps.map((entry: any) => [entry.stepId, { status: "pending", updatedAt: now() }])),
    mission: { acceptance: { status: "pending" } },
    updatedAt: now(),
  });
  writeJson(path.join(missionDir, "model-settings.json"), {
    version: 1,
    workerModel: workerAdapterRef || options.adapterId || null,
    orchestratorModel: orchestratorAdapterRef || options.adapterId || null,
    workerReasoningEffort: options.reasoningEffort || "medium",
    defaultAdapterRef: options.adapterId || null,
    roleAssignments: {
      ...(options.adapterId
        ? {
            orchestrator: options.adapterId,
            worker: options.adapterId,
            validator: options.adapterId,
          }
        : {}),
      ...(workerAdapterRef ? { worker: workerAdapterRef } : {}),
      ...(orchestratorAdapterRef ? { orchestrator: orchestratorAdapterRef } : {}),
    },
    updatedAt: now(),
  });
  writeJson(path.join(missionDir, "runtime-custom-models.json"), { version: 1, customModels: [] });

  if (options.adapterId) {
    saveAdapter(missionDir, {
      id: options.adapterId,
      adapterId: options.adapterId,
      provider: options.providerType,
      providerType: options.providerType,
      model: options.model,
      modelName: options.model,
      displayName: options.adapterLabel || options.adapterId,
      baseUrl: options.baseUrl,
      apiKeyEnvVar: options.apiKeyEnv,
      noImageSupport: true,
      timeoutMs: options.timeoutMs,
      retryPolicy: {
        maxRetries: options.adapterRetries,
        backoffMs: options.adapterBackoffMs,
      },
      fallbackAdapterIds: [],
      capabilityFlags: options.capability || [],
      enabled: true,
      notes: options.adapterNotes,
    });
  }

  event(missionDir, "mission_initialized", {
    missionId,
    workingDirectory: workspaceDir,
    steps: steps.length,
  });
  return { ok: true, missionId, missionDir };
}

export function pauseMission(missionDir: string): Record<string, any> {
  const state = missionState(missionDir);
  state.pauseRequested = true;
  state.state = "pause_requested";
  state.status = "pause_requested";
  state.resumeFrom = state.currentStepId;
  writeJson(path.join(missionDir, "state.json"), state);
  fs.writeFileSync(path.join(missionDir, "pause.requested"), now(), "utf8");
  event(missionDir, "mission_pause_requested", { resumeFrom: state.resumeFrom });
  return { ok: true, status: "pause_requested", resumeFrom: state.resumeFrom };
}

export async function resumeMission(
  missionDir: string,
  run = false,
  maxSteps = 10,
  maxParallel = 4,
): Promise<Record<string, any>> {
  fs.rmSync(path.join(missionDir, "pause.requested"), { force: true });
  const state = missionState(missionDir);
  state.pauseRequested = false;
  state.state = "active";
  state.status = "active";
  state.phase = "executing";
  state.activeStepIds = Array.isArray(state.activeStepIds) ? state.activeStepIds : [];
  state.maxParallel = maxParallel;
  syncActiveStepState(state);
  writeJson(path.join(missionDir, "state.json"), state);
  event(missionDir, "mission_resumed", {
    resumeWorkerSessionId: state.latestAttemptId,
    resumeFrom: state.resumeFrom,
    maxParallel,
  });
  if (!run) {
    return { ok: true, status: "resumed", resumeFrom: state.resumeFrom };
  }
  return await runMission(missionDir, maxSteps, true, true, maxParallel);
}

export async function restartMission(
  missionDir: string,
  run = false,
  maxSteps = 10,
  maxParallel = 4,
): Promise<Record<string, any>> {
  releaseLock(missionDir);
  fs.rmSync(path.join(missionDir, "pause.requested"), { force: true });
  const state = missionState(missionDir);
  state.pauseRequested = false;
  state.state = "active";
  state.status = "active";
  state.phase = "executing";
  state.activeStepIds = [];
  state.maxParallel = maxParallel;
  syncActiveStepState(state);
  writeJson(path.join(missionDir, "state.json"), state);
  const features = missionFeatures(missionDir);
  const current = (features.steps || []).find((entry: any) => entry.stepId === state.currentStepId);
  if (current && current.status === "in_progress") {
    current.status = "failed";
    current.failureClass = "orphan_cleanup";
    writeJson(path.join(missionDir, "features.json"), features);
  }
  event(missionDir, "worker_failed", {
    stepId: state.currentStepId,
    attemptId: state.latestAttemptId,
    reason: "orphan_cleanup",
  });
  event(missionDir, "mission_run_started", {
    message: "Restarting mission from scratch",
    restart: true,
    maxParallel,
  });
  if (!run) {
    return { ok: true, status: "restarted", resumeFrom: state.resumeFrom };
  }
  return await runMission(missionDir, maxSteps, false, true, maxParallel);
}

export function abortMission(missionDir: string, reason?: string | null): Record<string, any> {
  const state = missionState(missionDir);
  state.state = "aborted";
  state.status = "aborted";
  state.phase = "aborted";
  state.abortReason = reason || "user_requested";
  writeJson(path.join(missionDir, "state.json"), state);
  releaseLock(missionDir);
  fs.rmSync(path.join(missionDir, "pause.requested"), { force: true });
  event(missionDir, "mission_aborted", { reason: state.abortReason });
  return { ok: true, status: "aborted" };
}

export async function exportMission(missionDir: string, output?: string | null): Promise<Record<string, any>> {
  const destination = output ? path.resolve(expandHome(output)) : `${missionDir}.tar.gz`;
  await tar.create(
    {
      gzip: true,
      file: destination,
      cwd: path.dirname(missionDir),
      filter: (entryPath) => !entryPath.endsWith("run.lock"),
    },
    [path.basename(missionDir)],
  );
  event(missionDir, "mission_exported", { outputPath: destination });
  return { ok: true, path: destination };
}

export function addStep(missionDir: string, options: Record<string, any>): Record<string, any> {
  const features = missionFeatures(missionDir);
  const stepId = options.stepId || `step-${String((features.steps || []).length + 1).padStart(3, "0")}`;
  const step = {
    stepId,
    title: options.title,
    objective: options.objective || options.title,
    type: options.type || "llm_worker",
    status: "pending",
    owner: options.owner || "worker",
    attemptCount: 0,
    retryBudget: options.retryBudget,
    dependsOn: options.dependsOn || [],
    checks: (options.validate || []).map((command: string, index: number) => ({
      name: `validate-${index + 1}`,
      kind: "command",
      command,
      required: true,
    })),
  } as any;
  if (options.command) {
    step.command = options.command;
  }
  if (options.commandTemplate) {
    step.commandTemplate = options.commandTemplate;
  }
  if (options.adapterRef) {
    step.adapterRef = options.adapterRef;
  }
  if (options.allowModelCommands) {
    step.allowModelCommands = true;
  }
  if (options.question) {
    step.question = options.question;
  }
  if (options.reason) {
    step.reason = options.reason;
  }
  if (options.answer) {
    step.answer = options.answer;
    step.answeredAt = now();
  }
  features.steps ||= [];
  features.steps.push(step);
  writeJson(path.join(missionDir, "features.json"), features);
  const validationState = missionValidationState(missionDir);
  validationState.assertions ||= {};
  validationState.assertions[stepId] = { status: "pending", updatedAt: now() };
  writeJson(path.join(missionDir, "validation-state.json"), validationState);
  return { ok: true, step };
}

export function answerStepQuestion(missionDir: string, stepId: string, response: string): Record<string, any> {
  const features = missionFeatures(missionDir);
  const step = (features.steps || []).find((entry: any) => entry.stepId === stepId);
  if (!step) {
    throw new Error(`step not found: ${stepId}`);
  }
  if (step.type !== "ask_user") {
    throw new Error(`step is not ask_user: ${stepId}`);
  }
  step.answer = response;
  step.answeredAt = now();
  step.status = "pending";
  step.failureClass = null;
  step.failureDetail = null;
  writeJson(path.join(missionDir, "features.json"), features);

  const state = missionState(missionDir);
  if (state.currentStepId === stepId || state.status === "waiting_user") {
    state.state = "active";
    state.status = "active";
    state.phase = "executing";
    state.resumeFrom = stepId;
    writeJson(path.join(missionDir, "state.json"), state);
  }
  event(missionDir, "mission_question_answered", {
    stepId,
    responsePreview: shortText(response, 400),
  });
  return { ok: true, stepId, response };
}

export function addAdapter(missionDir: string, options: Record<string, any>): Record<string, any> {
  if (options.apiKey) {
    throw new Error("Refusing to store raw API key. Use --api-key-env.");
  }
  const existing = options.adapterId ? readJson(path.join(missionDir, "runtime-custom-models.json"), { customModels: [] }).customModels
    ?.find((entry: any) => entry.id === options.adapterId || entry.adapterId === options.adapterId) : null;
  const adapter = assignDefined(existing ? { ...existing } : {}, {
    id: options.adapterId,
    adapterId: options.adapterId,
    provider: options.providerType,
    providerType: options.providerType,
    model: options.model,
    modelName: options.model,
    displayName: options.label || (existing?.displayName ? undefined : options.adapterId),
    baseUrl: options.baseUrl,
    apiKeyEnvVar: options.apiKeyEnv,
    noImageSupport: true,
    maxOutputTokens: options.maxOutputTokens,
    timeoutMs: options.timeoutMs,
    notes: options.notes,
    command: options.command,
  });
  if (options.retries !== undefined || options.backoffMs !== undefined || !adapter.retryPolicy) {
    adapter.retryPolicy = {
      maxRetries: options.retries ?? adapter.retryPolicy?.maxRetries ?? 1,
      backoffMs: options.backoffMs ?? adapter.retryPolicy?.backoffMs ?? 500,
    };
  }
  if (options.fallback?.length) {
    adapter.fallbackAdapterIds = options.fallback;
  } else if (!adapter.fallbackAdapterIds) {
    adapter.fallbackAdapterIds = [];
  }
  if (options.capability?.length) {
    adapter.capabilityFlags = options.capability;
  } else if (!adapter.capabilityFlags) {
    adapter.capabilityFlags = [];
  }
  if (options.disabled) {
    adapter.enabled = false;
  } else if (adapter.enabled === undefined) {
    adapter.enabled = true;
  }
  saveAdapter(missionDir, adapter);
  const settings = readJson(path.join(missionDir, "model-settings.json"), {});
  settings.roleAssignments ||= {};
  for (const role of options.role || []) {
    settings.roleAssignments[role] = options.adapterId;
    settings[`${role}Model`] = options.adapterId;
  }
  writeJson(path.join(missionDir, "model-settings.json"), settings);
  return { ok: true, adapter };
}

export function listRoutes(missionDir: string): Record<string, any> {
  const settings = readJson(path.join(missionDir, "model-settings.json"), {});
  const features = missionFeatures(missionDir);
  return {
    defaultAdapterRef: settings.defaultAdapterRef || null,
    roleAssignments: settings.roleAssignments || {},
    stepRoutes: (features.steps || [])
      .filter((entry: any) => entry.adapterRef)
      .map((entry: any) => ({
        stepId: entry.stepId,
        title: entry.title,
        type: entry.type,
        adapterRef: entry.adapterRef,
      })),
  };
}

export function assignRoleAdapter(missionDir: string, role: string, adapterId: string): Record<string, any> {
  getAdapter(missionDir, adapterId);
  const settings = readJson(path.join(missionDir, "model-settings.json"), {});
  settings.roleAssignments ||= {};
  settings.roleAssignments[role] = adapterId;
  settings[`${role}Model`] = adapterId;
  writeJson(path.join(missionDir, "model-settings.json"), settings);
  event(missionDir, "adapter_role_assigned", { role, adapterId });
  return { ok: true, role, adapterId };
}

export function routeStepAdapter(missionDir: string, stepId: string, adapterRef?: string | null): Record<string, any> {
  const features = missionFeatures(missionDir);
  const step = (features.steps || []).find((entry: any) => entry.stepId === stepId);
  if (!step) {
    throw new Error(`step not found: ${stepId}`);
  }
  if (adapterRef) {
    step.adapterRef = adapterRef;
  } else {
    delete step.adapterRef;
  }
  writeJson(path.join(missionDir, "features.json"), features);
  event(missionDir, "step_adapter_routed", {
    stepId,
    adapterRef: adapterRef || null,
  });
  return { ok: true, stepId, adapterRef: step.adapterRef || null };
}

export function listAdapters(missionDir: string): Record<string, any> {
  return { adapters: adapterRegistry(missionDir).customModels || [] };
}

export async function testAdapter(
  missionDir: string,
  adapterId: string,
  prompt = "Reply with OK and one short sentence.",
): Promise<Record<string, any>> {
  try {
    const response = await callAdapter(missionDir, adapterId, prompt, "smoke_test");
    return {
      ok: true,
      adapterId,
      providerType: response.providerType,
      model: response.model,
      contentPreview: shortText(response.content || "", 300),
      durationMs: response.durationMs,
    };
  } catch (error) {
    return {
      ok: false,
      adapterId,
      error: errorCategory(error),
      message: shortText(error instanceof Error ? error.message : String(error), 800),
    };
  }
}
