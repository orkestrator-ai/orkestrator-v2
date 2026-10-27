import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import type {
  DesignExportPreview,
  DesignExportReceipt,
} from "@orkestrator/protocol/design-operations";

/**
 * Design export into a container Orkestrator created, against a profile started
 * with `--fixture-environments local,container`. Unlike
 * `apps/backend/src/core/design/export-container.test.ts`, which starts a bare
 * container of the image, this goes through the real gateway into the fixture
 * environment's container: its network-policy entrypoint, cloned workspace and
 * the `ContainerService` lifecycle. The client-kill interruptions stay in the
 * backend test, which owns the spawn seam they need.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

type DesignResult<T> =
  { ok: true; value: T } | { ok: false; failure: { code: string; message: string } };

function mise(args: string[]) {
  const command = spawnSync("mise", ["run", ...args, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || `${args[0]} failed`);
  return JSON.parse(command.stdout) as Record<string, unknown>;
}

/** Bounded Docker client call; Docker Desktop's `stop` can take many seconds. */
function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 90_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function gateway(page: Page, browserUrl: string) {
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(new URL("/__orkestrator/invoke", browserUrl).href, {
      data: { command, args },
    });
    expect(response.ok(), command).toBe(true);
    return (await response.json()).result as T;
  };
}

test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");

test("Docker fixture design export lands in an Orkestrator container and survives its lifecycle", async ({
  page,
}) => {
  test.setTimeout(6 * 60_000);
  const status = mise(["dev:status"]) as {
    status: string;
    browserUrl: string;
    testProject: string;
  };
  expect(status.status).toBe("ready");
  // The one-shot login URL is parsed in memory and never copied into output.
  const { loginUrl } = mise(["dev:login"]) as { loginUrl: string };
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  const invoke = await gateway(page, status.browserUrl);
  const design = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    const result = await invoke<DesignResult<T>>(command, args);
    if (!result.ok) throw Object.assign(new Error(result.failure.message), result.failure);
    return result.value;
  };
  const designFailure = async (command: string, args: Record<string, unknown>) => {
    const result = await invoke<DesignResult<unknown>>(command, args);
    expect(result.ok, `${command} should fail`).toBe(false);
    return (result as { failure: { code: string } }).failure;
  };

  const projects = await invoke<Array<{ id: string; localPath: string }>>("get_projects");
  const project = projects.find((candidate) => candidate.localPath === status.testProject)!;
  const environments = await invoke<
    Array<{ id: string; name: string; environmentType: string; containerId?: string | null }>
  >("get_environments", { projectId: project.id });
  const env = environments.find((candidate) => candidate.name === "fixture-container")!;
  expect(env, "fixture-container environment").toBeTruthy();
  const waitRunning = async () => {
    await expect
      .poll(
        async () =>
          (
            await invoke<{ status: string; containerId?: string }>("get_environment", {
              environmentId: env.id,
            })
          ).status,
        { timeout: 3 * 60_000 },
      )
      .toBe("running");
    const current = await invoke<{ containerId: string }>("get_environment", {
      environmentId: env.id,
    });
    return current.containerId;
  };
  const exec = (containerId: string, script: string) =>
    docker(["exec", "-u", "node", containerId, "sh", "-c", script]);

  let containerId = await waitRunning();
  const action = <T>(name: string, input: Record<string, unknown>) =>
    invoke<T>("design_action", { environmentId: env.id, action: name, input });
  const canvas = await action<DesignCanvas>("create_canvas", { name: "Container export" });
  await action("create_frame", {
    canvasId: canvas.id,
    expectedRevision: 1,
    name: "Screen",
    x: 0,
    y: 0,
    width: 480,
    height: 320,
    html: "<h1>Container export</h1>",
  });
  const exportPath = `designs/container-${canvas.id.slice(0, 8)}.orkdes`;
  const stoppedPath = `designs/stopped-${canvas.id.slice(0, 8)}.orkdes`;
  try {
    // Round trip into the cloned workspace, owned by the container user.
    const preview = await design<DesignExportPreview>("design_export_preview", {
      environmentId: env.id,
      canvasId: canvas.id,
      relativePath: exportPath,
    });
    expect(preview.target).toMatchObject({ exists: false, needsReplaceConfirmation: false });
    const receipt = await design<DesignExportReceipt>("design_export_save", {
      environmentId: env.id,
      canvasId: canvas.id,
      relativePath: exportPath,
      revision: 2,
    });
    expect(receipt).toMatchObject({ revision: 2, replaced: false, relativePath: exportPath });
    const saved = await invoke<{ content: string }>("read_container_file", {
      containerId,
      filePath: exportPath,
    });
    expect(JSON.parse(saved.content)).toMatchObject({
      id: canvas.id,
      format: "orkdes",
      revision: 2,
    });
    expect(exec(containerId, `stat -c '%U %a' /workspace/${exportPath}`)).toBe("node 644");
    // It is a repository file: git sees it, and no temporary file is left.
    expect(
      exec(containerId, "cd /workspace && git status --porcelain --untracked-files=all designs"),
    ).toContain(exportPath);
    expect(exec(containerId, "ls -A /workspace/designs")).not.toMatch(/\.tmp/);
    const again = await design<DesignExportPreview>("design_export_preview", {
      environmentId: env.id,
      canvasId: canvas.id,
    });
    expect(again.suggestedPath).toBe(exportPath);
    expect(again.target).toMatchObject({ sameCanvas: true, fingerprint: receipt.digest });

    // A container stopped outside Orkestrator refuses before writing, and
    // leaves nothing to reconcile.
    docker(["stop", "-t", "1", containerId]);
    const failure = await designFailure("design_export_save", {
      environmentId: env.id,
      canvasId: canvas.id,
      relativePath: stoppedPath,
      revision: 2,
    });
    expect(failure.code).toBe("storage");
    expect(
      await design("design_export_reconcile", { environmentId: env.id, canvasId: canvas.id }),
    ).toEqual({ state: "none" });

    // Through Orkestrator's own lifecycle: the entrypoint and network policy run
    // again, the association survives, and a fingerprinted replace lands.
    await invoke("start_environment", { environmentId: env.id });
    containerId = await waitRunning();
    expect(exec(containerId, `test -e /workspace/${stoppedPath} && echo yes || echo no`)).toBe(
      "no",
    );
    await action("create_frame", {
      canvasId: canvas.id,
      expectedRevision: 2,
      name: "Second",
      x: 600,
      y: 0,
      width: 320,
      height: 240,
      html: "<p>Second</p>",
    });
    const afterRestart = await design<DesignExportPreview>("design_export_preview", {
      environmentId: env.id,
      canvasId: canvas.id,
    });
    expect(afterRestart.target).toMatchObject({
      sameCanvas: true,
      fingerprint: receipt.digest,
    });
    const replaced = await design<DesignExportReceipt>("design_export_save", {
      environmentId: env.id,
      canvasId: canvas.id,
      relativePath: exportPath,
      revision: 3,
      replaceFingerprint: receipt.digest,
    });
    expect(replaced).toMatchObject({ revision: 3, replaced: true });
    expect(replaced.digest).not.toBe(receipt.digest);
    const resaved = await invoke<{ content: string }>("read_container_file", {
      containerId,
      filePath: exportPath,
    });
    expect(JSON.parse(resaved.content)).toMatchObject({ id: canvas.id, revision: 3 });
    // An unconfirmed overwrite of the now-changed file is refused.
    const conflict = await designFailure("design_export_save", {
      environmentId: env.id,
      canvasId: canvas.id,
      relativePath: exportPath,
      revision: 3,
    });
    expect(conflict.code).not.toBe("storage");
  } finally {
    const current = await invoke<{ status: string; containerId?: string }>("get_environment", {
      environmentId: env.id,
    }).catch(() => null);
    if (current?.status !== "running")
      await invoke("start_environment", { environmentId: env.id }).catch(() => undefined);
    const id = await waitRunning().catch(() => null);
    if (id) {
      spawnSync(
        "docker",
        [
          "exec",
          "-u",
          "node",
          id,
          "rm",
          "-f",
          `/workspace/${exportPath}`,
          `/workspace/${stoppedPath}`,
        ],
        { timeout: 60_000 },
      );
    }
    await action("delete_canvas", { canvasId: canvas.id }).catch(() => undefined);
  }
});
