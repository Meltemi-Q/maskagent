#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const srcDir = path.join(rootDir, "src");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function pythonUsable(candidate) {
  if (!candidate) {
    return false;
  }
  const probe = spawnSync(
    candidate,
    ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 9)"],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

const pythonCandidates = [
  process.env.MASKAGENT_PYTHON,
  "python3",
  "python",
];

const pythonBin = pythonCandidates.find(pythonUsable);

if (!existsSync(srcDir)) {
  fail(`MaskAgent source directory not found: ${srcDir}`);
}

if (!pythonBin) {
  fail("MaskAgent requires Python 3.9+ on PATH. Set MASKAGENT_PYTHON if needed.");
}

const env = { ...process.env };
env.PYTHONPATH = env.PYTHONPATH ? `${srcDir}${path.delimiter}${env.PYTHONPATH}` : srcDir;

const result = spawnSync(
  pythonBin,
  ["-m", "mission_runtime.cli", ...process.argv.slice(2)],
  { stdio: "inherit", env },
);

if (result.error) {
  fail(result.error.message);
}

process.exit(result.status ?? 1);
