import { acknowledgeDockerReachabilityWarning } from "../docker-reachability-warning";
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { processTree } from "./process-tree";
import { HEADLESS_ELECTRON_SWITCHES } from "../../apps/desktop/electron/runtime-profile";

/**
 * What `dev:test --headless` promises, read from the running processes rather
 * than from the launcher's arguments: nothing in the profile's Electron tree can
 * reach the signed-in desktop, and the app is still served to a browser. The
 * one-shot isolated runners set `ORKESTRATOR_AGENT_TEST_HEADLESS=1`, so each of
 * their runs records this. Only variable names are compared; no value is read
 * into an assertion message.
 */

type Status = {
  status: string;
  browserUrl?: string;
  pids?: { electron?: number };
  live?: Record<string, boolean>;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const DISPLAY_VARIABLES = ["DISPLAY", "WAYLAND_DISPLAY", "ELECTRON_OZONE_PLATFORM_HINT"];

function profileCommand<T>(command: string): T {
  const result = spawnSync("mise", ["run", command, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${command} failed`);
  return JSON.parse(result.stdout) as T;
}

function nullSeparated(file: string): string[] | null {
  try {
    return readFileSync(file, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

test.beforeEach(async ({ page }) => acknowledgeDockerReachabilityWarning(page));

test("a headless profile's Electron has no display and the app is served to a browser", async ({
  page,
}) => {
  test.skip(
    process.platform !== "linux" || process.env.ORKESTRATOR_AGENT_TEST_HEADLESS !== "1",
    "Linux only, against a profile started headless (ORKESTRATOR_AGENT_TEST_HEADLESS=1)",
  );
  const status = profileCommand<Status>("dev:status");
  expect(status.status).toBe("ready");
  expect(status.live?.electron).toBe(true);
  const electron = status.pids?.electron;
  if (!electron) throw new Error("The profile reports no Electron process");

  const processes = processTree(electron).flatMap((pid) => {
    const commandLine = nullSeparated(`/proc/${pid}/cmdline`);
    const environment = nullSeparated(`/proc/${pid}/environ`);
    return commandLine && environment ? [{ pid, commandLine, environment }] : [];
  });
  expect(processes.length).toBeGreaterThan(0);
  for (const { pid, environment } of processes) {
    const names = environment.map((entry) => entry.slice(0, entry.indexOf("=")));
    expect(
      names.filter((name) => DISPLAY_VARIABLES.includes(name)),
      `display variables in Electron process ${pid}`,
    ).toEqual([]);
  }
  // The launcher's own child carries the leading switches; `.bin/electron` hands
  // them to the real binary, whose children above inherited the environment.
  expect(processes[0]!.commandLine).toEqual(
    expect.arrayContaining([...HEADLESS_ELECTRON_SWITCHES]),
  );

  const { loginUrl } = profileCommand<{ loginUrl: string }>("dev:login");
  await page.goto(loginUrl);
  await expect(
    page.getByRole("button", { name: /^(Expand|Collapse) project / }).first(),
  ).toBeVisible({ timeout: 30_000 });
});
