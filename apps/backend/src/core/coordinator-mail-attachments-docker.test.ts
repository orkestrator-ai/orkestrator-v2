/**
 * A coordinator's pasted image mailed into a real container, through the real
 * send command, the real mail store and the real `docker exec` path.
 *
 * Opt-in: `ORKESTRATOR_TEST_DOCKER_IMAGE=orkestrator-v2:latest`. The container
 * runs that image with no network (`--network none`, so no firewall or Docker
 * network is touched), a fresh Git checkout as `/workspace` and the image's
 * own default user, and is removed afterwards. Everything else about the
 * container path is covered by `coordinator-mail-attachments.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type { AgentMailAttachment } from "@orkestrator/protocol/agent-mail";

import { MailWorld } from "./agent-mail-world-test-support.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { Environment } from "./models.js";

const image = process.env.ORKESTRATOR_TEST_DOCKER_IMAGE;
const dockerAvailable =
  Boolean(image) && spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

function inContainer(containerId: string, args: string[], user?: string) {
  const run = spawnSync(
    "docker",
    ["exec", ...(user ? ["--user", user] : []), "-w", "/workspace", containerId, ...args],
    { encoding: "utf8" },
  );
  return { status: run.status, stdout: run.stdout.trim() };
}

describe.skipIf(!dockerAvailable)("send_message with attachments, into a real container", () => {
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
          "exec sleep 300",
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
    world = await MailWorld.create();
  }, 60_000);

  afterAll(async () => {
    if (containerId) spawnSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
    await world?.close();
  });

  test("lands in /workspace, readable by the agent's user, Git-excluded and not duplicated", async () => {
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
    const source = await world.storage.coordinators.writeCoordinatorAttachment(
      world.coordinatorId,
      main.conversationId!,
      "shot.png",
      PNG.toString("base64"),
    );
    const args = {
      projectId: world.projectId,
      coordinatorId: world.coordinatorId,
      conversationId: main.conversationId!,
      requestId: "docker-1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      body: "See the image.",
      attachments: [path.basename(source)],
    };
    const send = () =>
      commands.get("send_coordinator_agent_mail")!(args, context) as Promise<{
        attachments: AgentMailAttachment[];
      }>;

    const sent = await send();
    const placed = sent.attachments[0]!;
    expect(placed.path.startsWith("/workspace/.orkestrator/mail-attachments/")).toBe(true);

    const digest = createHash("sha256").update(PNG).digest("hex");
    expect(placed.sha256).toBe(digest);
    // The agent runs as the image's `node` user; it can read the file.
    const read = inContainer(containerId, ["sha256sum", "--", placed.path], "node");
    expect(read.status).toBe(0);
    expect(read.stdout.split(/\s/)[0]).toBe(digest);
    // Git ignores it, so a commit or PR from this checkout cannot pick it up.
    expect(
      inContainer(containerId, ["git", "status", "--porcelain", "--untracked-files=all"]),
    ).toEqual({
      status: 0,
      stdout: "",
    });
    expect(
      inContainer(containerId, ["git", "check-ignore", "--quiet", "--no-index", "--", placed.path])
        .status,
    ).toBe(0);
    expect(inContainer(containerId, ["git", "add", "-A"]).status).toBe(0);
    expect(inContainer(containerId, ["git", "diff", "--cached", "--name-only"]).stdout).toBe("");

    const again = await send();
    expect(again.attachments).toEqual(sent.attachments);
    const listed = inContainer(containerId, ["ls", path.posix.dirname(placed.path)]);
    expect(listed.stdout.split("\n")).toEqual([path.basename(placed.path)]);
    const inbox = await world.storage.getAgentMailMailbox(worker.environmentId, worker.tabId);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]!.attachments).toEqual(sent.attachments);
  }, 60_000);
});
