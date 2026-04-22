#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

function shellQuote(value: string): string {
  if (!value.length) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".mjs": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".txt": "text/plain; charset=utf-8",
    }[ext] || "application/octet-stream"
  );
}

function within(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function findBrowser(): string {
  const candidates = [
    process.env.MASKAGENT_BROWSER_BIN,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) {
      return candidate;
    }
    const found = spawnSync("which", [candidate], { encoding: "utf8" });
    if (found.status === 0) {
      return found.stdout.trim();
    }
  }
  throw new Error("No supported browser found. Set MASKAGENT_BROWSER_BIN to Chrome or Edge.");
}

async function runCommand(command: string[], timeoutSeconds: number): Promise<Record<string, any>> {
  const stdoutPath = path.join(os.tmpdir(), `maskagent-browser-stdout-${process.pid}-${Date.now()}.log`);
  const stderrPath = path.join(os.tmpdir(), `maskagent-browser-stderr-${process.pid}-${Date.now()}.log`);
  const stdoutHandle = fs.openSync(stdoutPath, "w");
  const stderrHandle = fs.openSync(stderrPath, "w");
  const child = spawn(command[0], command.slice(1), {
    stdio: ["ignore", stdoutHandle, stderrHandle],
    detached: process.platform !== "win32",
  });
  let timedOut = false;
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

  const startedAt = Date.now();
  while (exitCode === null) {
    if (Date.now() - startedAt >= timeoutSeconds * 1000) {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        child.kill("SIGTERM");
      }
      await sleep(500);
      if (exitCode === null) {
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          child.kill("SIGKILL");
        }
      }
      break;
    }
    await sleep(100);
  }

  await closePromise;
  fs.closeSync(stdoutHandle);
  fs.closeSync(stderrHandle);
  const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf8") : "";
  const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, "utf8") : "";
  fs.rmSync(stdoutPath, { force: true });
  fs.rmSync(stderrPath, { force: true });
  return { exitCode: exitCode ?? 1, stdout, stderr, timedOut };
}

async function runBrowser(
  browser: string,
  url: string,
  screenshotPath: string,
  dumpPath: string,
): Promise<Record<string, any>> {
  const common = [
    browser,
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--virtual-time-budget=3000",
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    common.push("--no-sandbox");
  }

  const screenshotResult = await runCommand(
    [...common, "--window-size=1440,960", `--screenshot=${screenshotPath}`, url],
    20,
  );
  if (screenshotResult.exitCode !== 0 && !fs.existsSync(screenshotPath)) {
    throw new Error(`browser screenshot failed: ${screenshotResult.stderr || screenshotResult.stdout}`);
  }

  const pageSource = await fetch(url).then((response) => response.text());
  const dumpResult = await runCommand([...common, "--dump-dom", url], 15);
  const dumpText = dumpResult.exitCode === 0 && dumpResult.stdout.trim() ? dumpResult.stdout : pageSource;
  fs.writeFileSync(dumpPath, dumpText, "utf8");
  return {
    stdout: dumpText,
    stderr: dumpResult.stderr,
    pageSource,
    screenshotTimedOut: screenshotResult.timedOut,
    dumpTimedOut: dumpResult.timedOut,
  };
}

function parseArgs(argv: string[]): Record<string, any> {
  const args = [...argv];
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    throw new Error(
      "usage: browser-platformer-check <workspace> [--entry index.html] [--output-dir DIR] [--expect TERM]",
    );
  }
  const workspace = args.shift()!;
  const options: Record<string, any> = {
    workspace,
    entry: "index.html",
    outputDir: undefined,
    expect: ["<canvas", "platformer", "move", "jump"],
  };
  while (args.length) {
    const flag = args.shift();
    if (flag === "--entry") {
      options.entry = args.shift();
    } else if (flag === "--output-dir") {
      options.outputDir = args.shift();
    } else if (flag === "--expect") {
      options.expect.push(args.shift());
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArgs(argv);
    const workspace = path.resolve(options.workspace);
    const entryPath = path.join(workspace, options.entry);
    if (!fs.existsSync(entryPath)) {
      process.stderr.write(`missing entry file: ${entryPath}\n`);
      return 2;
    }
    const outputDir = path.resolve(options.outputDir || path.join(workspace, ".maskagent-browser-check"));
    fs.mkdirSync(outputDir, { recursive: true });
    const screenshotPath = path.join(outputDir, "browser-check.png");
    const dumpPath = path.join(outputDir, "browser-check.dom.html");
    const summaryPath = path.join(outputDir, "browser-check.summary.json");

    const server = http.createServer((request, response) => {
      const requestPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
      const relativePath = decodeURIComponent(requestPath === "/" ? `/${options.entry}` : requestPath).replace(/^\/+/, "");
      const filePath = path.resolve(workspace, relativePath);
      if (!within(workspace, filePath) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      response.setHeader("content-type", contentType(filePath));
      response.end(fs.readFileSync(filePath));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(null)));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start local browser check server");
    }
    const url = `http://127.0.0.1:${address.port}/${options.entry}`;
    try {
      const browser = findBrowser();
      const browserOutput = await runBrowser(browser, url, screenshotPath, dumpPath);
      const lower = String(browserOutput.stdout || "").toLowerCase();
      const missingTerms = (options.expect || []).filter((term: string) => !lower.includes(term.toLowerCase()));
      const summary = {
        ok: missingTerms.length === 0 && fs.existsSync(screenshotPath),
        url,
        browser,
        workspace,
        screenshot: screenshotPath,
        domDump: dumpPath,
        screenshotTimedOut: browserOutput.screenshotTimedOut,
        dumpTimedOut: browserOutput.dumpTimedOut,
        missingTerms,
      };
      fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      if (summary.ok) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        return 0;
      }
      process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 1;
    } finally {
      server.close();
    }
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    process.stderr.write(`${String(error)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
