/**
 * A containerized worker's own agent opens a mailed image with its read tool,
 * inside a real container (from to-do 4420 (retired) task 3; behaviour and
 * evidence in docs/architecture/coordinator.md, "Passing a pasted image on").
 *
 * The send, the copy into the container and the delivered prompt are the
 * production code: the real send command, mail store and injection drain, and
 * the real `docker exec` writer. The recipient is the image's own `claude`
 * CLI, run inside the container as the image's agent user (`node`) in
 * `/workspace`, pointed at a scripted Messages endpoint on the container's own
 * loopback (`mail-attachments-container-model-test-support.ts`).
 * The model takes the image path from the prompt the CLI sent it and asks for
 * `Read`; the test checks the CLI handed back the same bytes as image content.
 * No provider is called, no login is used and no credit is spent.
 *
 * Opt-in: `ORKESTRATOR_TEST_DOCKER_IMAGE=<an Orkestrator image>`. The
 * container runs with `--network none` (its loopback still works), so no
 * firewall or Docker network is touched, and it is removed afterwards. On a
 * host whose user cannot reach the Docker daemon, run it against
 * `mise run docker:disposable` with that daemon's `DOCKER_HOST`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { AgentMailAttachment } from "@orkestrator/protocol/agent-mail";

import { MailWorld } from "../agent-mail-world-test-support.js";
import type { CommandContext } from "../commands/context.js";
import { createCommandRegistry } from "../commands/registry.js";
import type { ModelRecord } from "./mail-attachments-container-model-test-support.js";
import { realPng } from "../mail-attachment-png-test-support.js";
import type { Environment } from "../models.js";

const image = process.env.ORKESTRATOR_TEST_DOCKER_IMAGE;
const dockerAvailable =
  Boolean(image) && spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;

const PNG = realPng();
const MODEL_PORT = 47420;
const MODEL_FILE = "/tmp/orkestrator-mail-read-model.ts";
const MODEL_RECORD = "/tmp/orkestrator-mail-read-model.json";
const MODEL_SOURCE = path.join(import.meta.dir, "mail-attachments-container-model-test-support.ts");

function inContainer(
  containerId: string,
  args: string[],
  options: { user?: string; input?: string; env?: Record<string, string>; timeoutMs?: number } = {},
) {
  const run = spawnSync(
    "docker",
    [
      "exec",
      ...(options.input === undefined ? [] : ["-i"]),
      ...(options.user ? ["--user", options.user] : []),
      ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "-w",
      "/workspace",
      containerId,
      ...args,
    ],
    { encoding: "utf8", input: options.input, timeout: options.timeoutMs ?? 30_000 },
  );
  return { status: run.status, stdout: run.stdout?.trim() ?? "", stderr: run.stderr ?? "" };
}

function modelRecord(containerId: string): ModelRecord | undefined {
  const read = inContainer(containerId, ["cat", MODEL_RECORD], { user: "node" });
  if (read.status !== 0 || !read.stdout) return undefined;
  return JSON.parse(read.stdout) as ModelRecord;
}

describe.skipIf(!dockerAvailable)("a containerized worker's agent reads a mailed image", () => {
  let containerId = "";
  let world: MailWorld;

  beforeAll(async () => {
    const run = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "sh",
        image!,
        "-c",
        [
          "cd /workspace",
          "git init -q -b main",
          "git -c user.email=qa@example.com -c user.name=QA commit -q --allow-empty -m init",
          "exec sleep 600",
        ].join(" && "),
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    containerId = run.stdout.trim();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (inContainer(containerId, ["git", "rev-parse", "HEAD"]).status === 0) break;
      await Bun.sleep(250);
    }
    // The scripted model, started with the image's own bun as the agent's user.
    expect(
      inContainer(containerId, ["sh", "-c", `cat > ${MODEL_FILE}`], {
        user: "node",
        input: readFileSync(MODEL_SOURCE, "utf8"),
      }).status,
    ).toBe(0);
    const started = spawnSync(
      "docker",
      [
        "exec",
        "-d",
        "--user",
        "node",
        containerId,
        "bun",
        MODEL_FILE,
        "--port",
        String(MODEL_PORT),
        "--record",
        MODEL_RECORD,
      ],
      { encoding: "utf8" },
    );
    expect(started.status).toBe(0);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = inContainer(containerId, [
        "curl",
        "-sf",
        "-X",
        "POST",
        `http://127.0.0.1:${MODEL_PORT}/v1/messages/count_tokens`,
      ]);
      if (probe.status === 0) break;
      await Bun.sleep(250);
    }
    expect(modelRecord(containerId)).toEqual({ calls: 0, asked: null, images: [] });
    world = await MailWorld.create();
  }, 90_000);

  afterAll(async () => {
    if (containerId) spawnSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
    await world?.close();
  });

  test("the image's Claude CLI opens the copy in /workspace with its Read tool", async () => {
    const commands = createCommandRegistry();
    const context = {
      storage: world.storage,
      coordinators: world.coordinator,
      drainAgentMail: () => world.mail.drainInjects(),
      runtime: {
        coordinatorRequests: world.coordinatorRequests,
        environments: { fence: { beginMutation: () => () => undefined } },
      },
    } as unknown as CommandContext;
    const main = await world.main();
    const worker = await world.addEnvironment("boxed", { launched: true });
    await world.storage.updateEnvironment(worker.environmentId, {
      environmentType: "containerized",
      containerId,
      status: "running",
    } as Partial<Environment>);
    // A launched worker starts mid-turn; mail then waits for it to go idle.
    await world.finishTurn(worker);
    const source = await world.storage.coordinators.writeCoordinatorAttachment(
      world.coordinatorId,
      main.conversationId!,
      "screenshot.png",
      PNG.toString("base64"),
    );
    const sent = (await commands.get("send_coordinator_agent_mail")!(
      {
        projectId: world.projectId,
        coordinatorId: world.coordinatorId,
        conversationId: main.conversationId!,
        requestId: "docker-read-1",
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
        body: "Here is the screenshot the user pasted.",
        attachments: [path.basename(source)],
      },
      context,
    )) as { attachments: AgentMailAttachment[] };
    const placed = sent.attachments[0]!;
    expect(placed.path.startsWith("/workspace/.orkestrator/mail-attachments/")).toBe(true);
    await world.deliver();
    const [prompt] = world.deliveredPrompts(worker);
    expect(prompt).toBeDefined();

    // The delivered prompt, as the worker's agent gets it, to the image's CLI.
    // `Read` is approved up front, as the Claude bridge does for every session
    // (`session-manager-prompt-query.ts`). The config directory is fresh, so
    // no setting or credential of the image's user is involved.
    const turn = inContainer(
      containerId,
      [
        "claude",
        "--print",
        "--tools",
        "Read",
        "--allowedTools",
        "Read",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--model",
        "claude-sonnet-4-6",
        "--max-turns",
        "3",
      ],
      {
        user: "node",
        input: prompt!,
        timeoutMs: 90_000,
        env: {
          CLAUDE_CONFIG_DIR: "/tmp/orkestrator-mail-read-claude",
          ANTHROPIC_API_KEY: "fixture-key",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
        },
      },
    );
    const record = modelRecord(containerId);
    const version = inContainer(containerId, ["claude", "--version"], { user: "node" }).stdout;
    console.info(
      `container claude ${version}: exit ${turn.status}, ${record?.calls ?? 0} model calls`,
    );

    expect(turn.status).toBe(0);
    expect(turn.stdout).toContain("Seen.");
    // The path came from the prompt the CLI sent the model, and is the copy.
    expect(record?.asked).toBe(placed.path);
    expect(record?.calls).toBe(2);
    expect(record?.images).toHaveLength(1);
    expect(Buffer.from(record!.images[0]!, "base64").equals(PNG)).toBe(true);
  }, 150_000);
});
