/**
 * Profile, login, sidebar and layout helpers shared by the opt-in live design
 * specs (`design-live.spec.ts`, `design-resume-clients-live.spec.ts`). Nothing
 * here runs at import time, so importing it never spawns `mise`.
 */
import { expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";

export type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
};
export type Project = { id: string; name: string; localPath: string | null };
export type Environment = { id: string; name: string; worktreePath?: string | null };
export type LayoutTab = {
  id: string;
  type: string;
  nativeAgentData?: { platform?: string };
  designCanvasData?: { canvasId: string };
};
export type LayoutNode =
  | { kind: "leaf"; tabs: LayoutTab[] }
  | { kind: "split"; children: LayoutNode[] };
export type SessionLink = {
  id?: string;
  tabId: string;
  platform: string;
  role: string;
  sessionId?: string;
};
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");

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

/** Sign `page` in with its own single-use login and return a command invoker. */
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
    await expect(expand.or(entry).first()).toBeVisible({ timeout: 30_000 });
    for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
      const continueButton = page.getByRole("button", { name: label, exact: true });
      if (await continueButton.isVisible()) await continueButton.click();
    }
    if (await expand.isVisible()) await expand.click();
    // A sidebar tooltip from the previous hover can sit over the entry. Never
    // press Escape to clear it: with nothing focused, Escape stops the active
    // tab's running turn (useEscapeToStop).
    await page.mouse.move(0, 0);
    await entry.click();
  };
}

export function layoutTabs(node: LayoutNode | undefined): LayoutTab[] {
  if (!node) return [];
  if (node.kind === "split") return node.children.flatMap(layoutTabs);
  return node.tabs;
}

/**
 * `ORKESTRATOR_AGENT_TEST_DESIGN_MODELS`: `<platform>=<model id>` pairs, for
 * example `claude=claude-haiku-4-5` when a busy account rate-limits the
 * default, or a Codex model the login offers when the default is not.
 */
export function selectedModel(platform: string): string | undefined {
  for (const pair of (process.env.ORKESTRATOR_AGENT_TEST_DESIGN_MODELS ?? "").split(",")) {
    const [name, model] = pair.split("=").map((value) => value.trim());
    if (name === platform && model) return model;
  }
  return undefined;
}
