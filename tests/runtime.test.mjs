import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

let cliModule;

async function loadCli() {
  if (!cliModule) {
    cliModule = await import("../dist/cli.js");
  }
  return cliModule;
}

function tempFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maskagent-test-"));
  const missions = path.join(root, "missions");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  process.env.MASKAGENT_HOME = missions;
  return {
    root,
    missions,
    workspace,
    cleanup() {
      delete process.env.MASKAGENT_HOME;
      delete process.env.MISSION_HOME;
      delete process.env.FAKE_API_KEY;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function missionDir(fixture) {
  const entries = fs.readdirSync(fixture.missions);
  assert.equal(entries.length, 1);
  return path.join(fixture.missions, entries[0]);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fakeServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("layout and secret policy", async (t) => {
  const fixture = tempFixture();
  t.after(() => fixture.cleanup());
  const { main } = await loadCli();
  assert.equal(
    await main([
      "init",
      "--name",
      "demo",
      "--goal",
      "plan",
      "--workspace",
      fixture.workspace,
      "--adapter-id",
      "fake",
      "--provider-type",
      "openai_compatible",
      "--base-url",
      "http://example.test/v1",
      "--api-key-env",
      "FAKE_API_KEY",
      "--model",
      "fake-model",
    ]),
    0,
  );
  const md = missionDir(fixture);
  for (const fileName of [
    "mission.md",
    "features.json",
    "state.json",
    "validation-state.json",
    "model-settings.json",
    "runtime-custom-models.json",
    "progress_log.jsonl",
    "worker-transcripts.jsonl",
  ]) {
    assert.ok(fs.existsSync(path.join(md, fileName)), fileName);
  }
  assert.ok(fs.statSync(path.join(md, "handoffs")).isDirectory());
  assert.ok(fs.statSync(path.join(md, "evidence")).isDirectory());
  const registryText = fs.readFileSync(path.join(md, "runtime-custom-models.json"), "utf8");
  assert.match(registryText, /FAKE_API_KEY/);
  assert.doesNotMatch(registryText, /sk-/);
  assert.ok(readJson(path.join(md, "state.json")).lastReviewedHandoffCount !== undefined);
  assert.equal(readJson(path.join(md, "features.json")).steps[0].type, "llm_worker");
});

test("default home is .maskagent not .factory", async (t) => {
  const fixture = tempFixture();
  t.after(() => fixture.cleanup());
  delete process.env.MASKAGENT_HOME;
  delete process.env.MISSION_HOME;
  const oldHome = process.env.HOME;
  process.env.HOME = fixture.root;
  const { main } = await loadCli();
  try {
    assert.equal(
      await main([
        "init",
        "--name",
        "default-home",
        "--goal",
        "check path",
        "--workspace",
        fixture.workspace,
        "--step-command",
        "true",
      ]),
      0,
    );
    assert.ok(fs.existsSync(path.join(fixture.root, ".maskagent", "missions")));
    assert.ok(!fs.existsSync(path.join(fixture.root, ".factory")));
  } finally {
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    process.env.MASKAGENT_HOME = fixture.missions;
  }
});

test("shell validator acceptance", async (t) => {
  const fixture = tempFixture();
  t.after(() => fixture.cleanup());
  const { main } = await loadCli();
  assert.equal(
    await main([
      "init",
      "--name",
      "shell",
      "--goal",
      "write marker",
      "--workspace",
      fixture.workspace,
      "--step-command",
      "printf ok > marker.txt",
      "--validate",
      "test -f marker.txt",
      "--accept",
      "grep -q ok marker.txt",
    ]),
    0,
  );
  const md = missionDir(fixture);
  assert.equal(await main(["run", path.basename(md), "--max-steps", "5"]), 0);
  assert.ok(fs.existsSync(path.join(fixture.workspace, "marker.txt")));
  assert.ok(fs.readdirSync(path.join(md, "handoffs")).some((name) => name.endsWith(".json")));
  assert.equal(readJson(path.join(md, "validation-state.json")).assertions["step-shell"].status, "pass");
  assert.equal(await main(["accept", path.basename(md)]), 0);
  assert.equal(readJson(path.join(md, "state.json")).state, "accepted");
});

test("external cli validator acceptance", async (t) => {
  const fixture = tempFixture();
  t.after(() => fixture.cleanup());
  const { main } = await loadCli();
  const command = `${process.execPath} -e "require('node:fs').writeFileSync('marker.txt', 'ok\\n')"`;
  assert.equal(
    await main([
      "init",
      "--name",
      "external-cli",
      "--goal",
      "write marker through external cli",
      "--workspace",
      fixture.workspace,
      "--worker-command",
      command,
      "--validate",
      "grep -q ok marker.txt",
      "--accept",
      "test -f marker.txt",
    ]),
    0,
  );
  const md = missionDir(fixture);
  assert.equal(await main(["run", path.basename(md), "--max-steps", "5"]), 0);
  assert.ok(fs.existsSync(path.join(fixture.workspace, "marker.txt")));
  assert.equal(readJson(path.join(md, "validation-state.json")).assertions["step-worker"].status, "pass");
  assert.equal(await main(["accept", path.basename(md)]), 0);
  assert.equal(readJson(path.join(md, "state.json")).state, "accepted");
});

test("llm json worker writes files and validates", async (t) => {
  const fixture = tempFixture();
  t.after(() => fixture.cleanup());
  process.env.FAKE_API_KEY = "fake-token-not-written";
  const server = await fakeServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "succeeded",
                summary: "created marker from fake LLM worker",
                files: [{ path: "llm-marker.txt", content: "hello from fake llm\n" }],
                commands: [],
                openIssues: [],
              }),
            },
          },
        ],
      }),
    );
  });
  t.after(() => server.close());
  const port = server.address().port;
  const { main } = await loadCli();
  assert.equal(
    await main([
      "init",
      "--name",
      "llm",
      "--goal",
      "create a marker using LLM JSON worker",
      "--workspace",
      fixture.workspace,
      "--adapter-id",
      "fake-openai",
      "--provider-type",
      "openai_compatible",
      "--base-url",
      `http://127.0.0.1:${port}/v1`,
      "--api-key-env",
      "FAKE_API_KEY",
      "--model",
      "fake",
      "--validate",
      "grep -q 'fake llm' llm-marker.txt",
      "--accept",
      "test -f llm-marker.txt",
    ]),
    0,
  );
  const md = missionDir(fixture);
  assert.equal(await main(["run", path.basename(md), "--max-steps", "3"]), 0);
  assert.equal(fs.readFileSync(path.join(fixture.workspace, "llm-marker.txt"), "utf8"), "hello from fake llm\n");
  assert.equal(readJson(path.join(md, "validation-state.json")).assertions["step-worker"].status, "pass");
  assert.match(fs.readFileSync(path.join(md, "attempts.jsonl"), "utf8"), /llm_json_delta/);
  assert.doesNotMatch(fs.readFileSync(path.join(md, "worker-transcripts.jsonl"), "utf8"), /fake-token-not-written/);
});

test("pause resume restart events", async (t) => {
  const fixture = tempFixture();
  t.after(() => fixture.cleanup());
  const { main } = await loadCli();
  assert.equal(
    await main([
      "init",
      "--name",
      "pause",
      "--goal",
      "noop",
      "--workspace",
      fixture.workspace,
      "--step-command",
      "true",
      "--validate",
      "true",
    ]),
    0,
  );
  const md = missionDir(fixture);
  assert.equal(await main(["pause", path.basename(md)]), 0);
  assert.equal(await main(["run", path.basename(md)]), 0);
  let log = fs.readFileSync(path.join(md, "progress_log.jsonl"), "utf8");
  assert.match(log, /mission_paused/);
  assert.equal(await main(["resume", path.basename(md)]), 0);
  assert.equal(await main(["restart", path.basename(md)]), 0);
  log = fs.readFileSync(path.join(md, "progress_log.jsonl"), "utf8");
  assert.match(log, /mission_resumed/);
  assert.match(log, /orphan_cleanup/);
});

test("pause during running step requeues current step", async (t) => {
  const fixture = tempFixture();
  t.after(() => fixture.cleanup());
  const { main } = await loadCli();
  const command = `${process.execPath} -e "setTimeout(() => require('node:fs').writeFileSync('marker.txt', 'ok\\n'), 5000)"`;
  assert.equal(
    await main([
      "init",
      "--name",
      "pause-running-step",
      "--goal",
      "pause and resume the active worker",
      "--workspace",
      fixture.workspace,
      "--step-command",
      command,
      "--validate",
      "grep -q ok marker.txt",
      "--accept",
      "test -f marker.txt",
    ]),
    0,
  );
  const md = missionDir(fixture);
  const runPromise = main(["run", path.basename(md), "--max-steps", "2"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await main(["pause", path.basename(md)]), 0);
  assert.equal(await runPromise, 0);
  const pausedState = readJson(path.join(md, "state.json"));
  const pausedFeatures = readJson(path.join(md, "features.json"));
  const pausedStep = pausedFeatures.steps.find((entry) => entry.stepId === "step-shell");
  assert.equal(pausedState.state, "paused");
  assert.equal(pausedState.resumeFrom, "step-shell");
  assert.equal(pausedStep.status, "pending");
  assert.equal(pausedStep.attemptCount, 0);
  assert.ok(!fs.existsSync(path.join(fixture.workspace, "marker.txt")));
  assert.equal(await main(["resume", path.basename(md), "--run", "--max-steps", "2"]), 0);
  assert.equal(await main(["accept", path.basename(md)]), 0);
  assert.equal(fs.readFileSync(path.join(fixture.workspace, "marker.txt"), "utf8"), "ok\n");
});

test("fake openai and anthropic adapters", async (t) => {
  const fixture = tempFixture();
  t.after(() => fixture.cleanup());
  process.env.FAKE_API_KEY = "fake-token-not-written";
  const openAiServer = await fakeServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK fake openai" } }] }));
  });
  t.after(() => openAiServer.close());
  const anthropicServer = await fakeServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ content: [{ type: "text", text: "OK fake anthropic" }] }));
  });
  t.after(() => anthropicServer.close());
  const { main } = await loadCli();
  assert.equal(
    await main([
      "init",
      "--name",
      "adapter",
      "--goal",
      "test",
      "--workspace",
      fixture.workspace,
      "--adapter-id",
      "fake-openai",
      "--provider-type",
      "openai_compatible",
      "--base-url",
      `http://127.0.0.1:${openAiServer.address().port}/v1`,
      "--api-key-env",
      "FAKE_API_KEY",
      "--model",
      "fake",
    ]),
    0,
  );
  const md = missionDir(fixture);
  assert.equal(await main(["adapters", "test", path.basename(md), "fake-openai"]), 0);
  assert.equal(
    await main([
      "adapters",
      "add",
      path.basename(md),
      "--adapter-id",
      "fake-anthropic",
      "--provider-type",
      "anthropic_compatible",
      "--base-url",
      `http://127.0.0.1:${anthropicServer.address().port}`,
      "--api-key-env",
      "FAKE_API_KEY",
      "--model",
      "fake",
    ]),
    0,
  );
  assert.equal(await main(["adapters", "test", path.basename(md), "fake-anthropic"]), 0);
  assert.doesNotMatch(fs.readFileSync(path.join(md, "worker-transcripts.jsonl"), "utf8"), /fake-token-not-written/);
});
