/**
 * Shared plumbing for the live slash-command specs
 * (`slash-command-inactive.spec.ts`, `slash-command-picker.spec.ts`): the
 * profile manifest, an authenticated invoke, sidebar navigation and a host
 * worktree's files. Nothing here runs at import time.
 */
import { expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dismissSidebarTooltip } from "./sidebar-tooltip";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
  dataDir?: string;
};
export type Project = { id: string; name: string; localPath: string | null };
export type Environment = {
  id: string;
  name: string;
  environmentType?: string;
  status?: string;
  setupPhase?: string;
  containerId?: string | null;
  worktreePath?: string | null;
};
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Files in the environment's workspace, by path relative to its root. */
export type Workspace = {
  write(relative: string, body: string): void;
  remove(relative: string): void;
  /** The file's text, or undefined when it does not exist. */
  read(relative: string): string | undefined;
};

export function assertRelative(relative: string) {
  if (path.posix.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw new Error(`not a workspace-relative path: ${relative}`);
  }
}

/** A host worktree: the provider reads the same files the runner writes. */
export function hostWorkspace(root: string): Workspace {
  return {
    write(relative, body) {
      assertRelative(relative);
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    },
    remove(relative) {
      assertRelative(relative);
      rmSync(path.join(root, relative), { force: true });
    },
    read(relative) {
      assertRelative(relative);
      const file = path.join(root, relative);
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    },
  };
}

export function profileStatus(profile: string): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) {
    throw new Error(
      `dev:status for profile "${profile}" returned no manifest: ${command.stderr.trim()}`,
    );
  }
  return JSON.parse(command.stdout) as Status;
}

export async function authenticatedInvoke(
  page: Page,
  status: Status,
  profile: string,
): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    // `page.request` is not subject to `context.setOffline`, so backend truth
    // stays readable while the page's own streams are cut.
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

export function sidebarNavigator(page: Page, projectName: string) {
  return async (name: string) => {
    const expand = page.getByRole("button", { name: `Expand project ${projectName}` });
    const entry = page.getByText(name, { exact: true }).first();
    // The mobile shell keeps the project list in a drawer.
    const openDrawer = page.getByRole("button", { name: "Open projects and environments" });
    await expect(expand.or(entry).or(openDrawer).first()).toBeVisible({ timeout: 30_000 });
    for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
      const continueButton = page.getByRole("button", { name: label, exact: true });
      if (await continueButton.isVisible()) await continueButton.click();
    }
    // The mobile shell has a drawer toggle and may already show the drawer.
    const mobile =
      (await page
        .getByRole("button", { name: /^(Open|Close) projects and environments$/ })
        .count()) > 0;
    if (mobile && (await openDrawer.isVisible())) await openDrawer.click();
    await expect(expand.or(entry).first()).toBeVisible({ timeout: 30_000 });
    if (await expand.isVisible()) await expand.click();
    if (!mobile) {
      // A sidebar tooltip from the previous hover can sit over the entry.
      // Escape is Stop unless focus is safely in the sidebar.
      await dismissSidebarTooltip(page, projectName);
    }
    await entry.click();
    const closeDrawer = page.getByRole("button", { name: "Close projects and environments" });
    if (await closeDrawer.first().isVisible()) await closeDrawer.first().click();
  };
}
