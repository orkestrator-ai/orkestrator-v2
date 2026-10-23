/** Corrupt-record recovery through the real renderer and backend on a disposable container. */
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import type {
  McpManagementSnapshot,
  McpManagementTarget,
} from "@orkestrator/protocol/mcp-management";
import { environmentStateDirectory } from "../../apps/backend/src/core/environment-state-paths";
import { writableSourcePath } from "./mcp-apply-live-safety";
import { loadAppWithDevRetry } from "./dev-startup-retry";

const root = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

test("container MCP reset recovers unreadable changes and rehydrates after reload", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1" &&
      process.env.ORKESTRATOR_AGENT_TEST_MCP_CONTAINER !== "1",
    "opt-in disposable Docker qualification",
  );
  test.setTimeout(240_000);
  const manifest = (task: string) => {
    const result = spawnSync("mise", ["run", task, "--profile", profile, "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, task).toBe(0);
    return JSON.parse(result.stdout);
  };
  const status = manifest("dev:status") as {
    status: string;
    flavor: string;
    dataDir: string;
    testProject: string;
    browserUrl: string;
  };
  expect(status.status).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  const login = manifest("dev:login") as { loginUrl: string };
  await loadAppWithDevRetry(page, testInfo, () => page.goto(login.loginUrl));
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args }, timeout: 120_000 },
    );
    expect(response.ok(), command).toBe(true);
    return (await response.json()).result as T;
  };
  const projects = await invoke<Array<{ id: string; localPath: string }>>("get_projects");
  const project = projects.find((item) => item.localPath === status.testProject)!;
  expect(project).toBeTruthy();
  const environment = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: `overlay-recovery-${Date.now()}`,
    environmentType: "containerized",
    networkAccessMode: "restricted",
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const { targets } = await invoke<{ targets: McpManagementTarget[] }>(
      "list_mcp_management_targets",
      { environmentId: environment.id },
    );
    const target = targets.find(
      (item) => item.provider === "codex" && item.context.kind === "environment",
    )!;
    const backend = targets.find(
      (item) => item.provider === "codex" && item.context.kind === "backend",
    )!;
    const snapshot = () =>
      invoke<McpManagementSnapshot>("get_mcp_management_snapshot", { targetId: target.targetId });
    const defaults = await invoke<McpManagementSnapshot>("get_mcp_management_snapshot", {
      targetId: backend.targetId,
    });
    const host = defaults.sources.find((item) => item.sourceId === "codex:user")!;
    const hostPath = writableSourcePath(host, {
      dataDir: status.dataDir,
      worktree: status.testProject,
      flavor: status.flavor,
    });
    expect(hostPath, "defaults stay inside the disposable profile").toBeTruthy();
    const readHost = () => (existsSync(hostPath!) ? readFileSync(hostPath!) : null);
    const before = readHost();
    const source = (await snapshot()).sources.find((item) => item.sourceId === "codex:user")!;
    await invoke("mutate_mcp_definition", {
      mutation: {
        requestId: `recovery-${Date.now()}`,
        targetId: target.targetId,
        applyIntent: "save",
        operation: {
          kind: "add",
          sourceId: source.sourceId,
          expectedRevision: source.revision,
          definition: { name: "recovery_probe", transport: "stdio", command: "node" },
        },
      },
    });
    const record = path.join(
      environmentStateDirectory(status.dataDir, "mcp-environment-overlays", environment.id),
      `${Buffer.from(source.sourceId).toString("base64url")}.json`,
    );
    writeFileSync(record, "{unreadable");
    expect(
      (await snapshot()).sources.find((item) => item.sourceId === source.sourceId)!.overlay?.state,
    ).toBe("corrupt");

    const openSettings = async () => {
      for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
        const button = page.getByRole("button", { name: label, exact: true });
        if (await button.isVisible()) await button.click();
      }
      await page.getByRole("button", { name: "Global settings", exact: true }).click();
      await page.getByRole("button", { name: "MCP servers", exact: true }).click();
      await page.getByRole("combobox", { name: "Agent platform" }).click();
      await page.getByRole("option", { name: "Codex", exact: true }).click();
      await page.getByRole("combobox", { name: "Configuration for" }).click();
      await page
        .getByRole("option", { name: `${environment.name} (container)`, exact: true })
        .click();
    };
    await openSettings();
    await expect(page.getByText("Saved changes could not be read", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const reset = page.getByRole("button", { name: "Reset to inherited…", exact: true });
    await expect(reset).toBeEnabled();
    await reset.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("saved baseline cannot be read");
    await dialog.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.getByText("Saved changes could not be read", { exact: true })).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await snapshot()).sources.find((item) => item.sourceId === source.sourceId)!.writable,
      )
      .toBe(true);
    expect(existsSync(record)).toBe(false);
    expect(
      (await snapshot()).definitions
        .filter((item) => item.sourceId === source.sourceId)
        .map((item) => item.name)
        .sort(),
    ).toEqual(
      defaults.definitions
        .filter((item) => item.sourceId === source.sourceId)
        .map((item) => item.name)
        .sort(),
    );
    const after = readHost();
    expect(
      before === null ? after === null : after !== null && after.equals(before),
      "backend defaults are unchanged",
    ).toBe(true);
    await page.reload();
    await openSettings();
    await expect(
      page.getByRole("button", { name: "Reset to inherited…", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Refresh from backend user…", exact: true }),
    ).toBeEnabled({ timeout: 60_000 });
  } finally {
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id });
  }
});
