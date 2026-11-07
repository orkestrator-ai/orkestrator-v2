import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { startFakeAnthropicModel } from "../e2e/agent-testing/fake-anthropic-model";
import { __testing, gatewayFor, isolatedClaudeDirectory } from "./tmux-mail-inject-live";
import { checkoutEnv } from "./recurring-live-ab";

/** WEB-3: one browser, one fixture environment, real native Claude on a held loopback turn.
 * Start a credential-free dev:test profile first. Run with --profile NAME --checkout ABS --out FILE.
 * Counts only command names, never bodies, credentials or transcript content. Profile cleanup is the caller's.
 */
export function rpcDelta(before: Record<string, number>, after: Record<string, number>) {
  for (const value of [...Object.values(before), ...Object.values(after)]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Gateway RPC counter invalid");
  }
  const result: Record<string, number> = {};
  for (const command of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const count = (after[command] ?? 0) - (before[command] ?? 0);
    if (!Number.isFinite(count) || count < 0)
      throw new Error("Gateway RPC counter reset or invalid");
    if (count) result[command] = count;
  }
  return result;
}

async function run(profile: string, checkout: string, out: string) {
  const command = (args: string[]) => {
    const result = spawnSync("mise", ["run", ...args], {
      cwd: checkout,
      env: checkoutEnv(checkout),
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.status !== 0) throw new Error(`Profile command failed: ${args[0]}`);
    return JSON.parse(result.stdout);
  };
  const status = command(["dev:status", "--profile", profile, "--json"]);
  if (status.status !== "ready") throw new Error("Profile is not ready");
  const directory = isolatedClaudeDirectory(status.dataDir, profile);
  const gateway = gatewayFor(status);
  const projects =
    await gateway.invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const project = projects.find((p) => p.localPath === status.testProject);
  if (!project) throw new Error("Profile has no seeded fixture project");
  const environments = await gateway.invoke<
    Array<{ id: string; name: string; environmentType: string; worktreePath: string }>
  >("get_environments", { projectId: project.id });
  const environment = environments.find((e) => e.environmentType === "local" && e.worktreePath);
  if (!environment || environments.length !== 1)
    throw new Error("Expected exactly one local fixture environment");
  const model = await startFakeAnthropicModel();
  let restore: (() => void) | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const evidence: Record<string, unknown> = {
    profile,
    at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    commit: spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
    }).stdout.trim(),
    environments: environments.length,
    viewport: { width: 1440, height: 1000 },
    method:
      "One gateway browser; native Claude CLI on loopback; held idle/working/idle turns; gateway commands counter deltas, 3s settling per boundary",
  };
  try {
    restore = __testing.mailRuntime.claudeFixture(
      directory,
      model.origin,
      environment.worktreePath,
    );
    const layout = await gateway.invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: environment.id,
    });
    await gateway.invoke("save_pane_layout", {
      environmentId: environment.id,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: 3,
        containerId: null,
        activePaneId: "web3-pane",
        root: {
          kind: "leaf",
          id: "web3-pane",
          activeTabId: "web3-tab",
          tabs: [
            {
              id: "web3-tab",
              type: "agent-native",
              displayTitle: "WEB-3 measurement",
              nativeAgentData: { environmentId: environment.id, platform: "claude", isLocal: true },
              initialAgentModel: "haiku",
            },
          ],
        },
      },
    });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const login = command(["dev:login", "--profile", profile, "--json"]);
    await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
    const waitFor = async (label: string, probe: () => Promise<boolean>, budget = 120_000) => {
      for (const deadline = Date.now() + budget; Date.now() < deadline;) {
        if (await probe()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`Timed out: ${label}`);
    };
    let quietSince = Date.now();
    for (let attempt = 0; attempt < 120; attempt++) {
      for (const label of [
        "Continue Without Docker",
        "Continue Without GitHub CLI",
        "Continue Without Claude",
      ]) {
        const button = page.getByRole("button", { name: label, exact: true });
        if (await button.isVisible()) await button.click();
      }
      const blocked = await page.getByRole("alertdialog").first().isVisible();
      if (blocked) quietSince = Date.now();
      if (
        !blocked &&
        Date.now() - quietSince >= 2_000 &&
        (await page.getByText(environment.name, { exact: true }).first().isVisible())
      )
        break;
      const expand = page.getByRole("button", {
        name: `Expand project ${project.name}`,
        exact: true,
      });
      if (await expand.isVisible()) await expand.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await page.getByText(environment.name, { exact: true }).first().click();
    const composer = page
      .getByTestId("shared-native-compose-bar")
      .getByRole("textbox", { name: /^Message Claude/ });
    await composer.waitFor({ state: "visible", timeout: 120_000 });
    const activity = async (wanted: string) =>
      page.evaluate(
        async ({ id, wanted }) => {
          // Observe the actual renderer projection, without changing store state.
          const modulePath = "/src/stores/environmentStore.ts";
          const { useEnvironmentStore } = await import(/* @vite-ignore */ modulePath);
          // A per-node store has no statics since 3018: read the command scope's instance.
          const scopeModulePath = "/src/lib/node-scope/app-window-scope.ts";
          const { getWindowScope } = await import(/* @vite-ignore */ scopeModulePath);
          return (
            getWindowScope()
              .commandScope()
              .store(useEnvironmentStore.def)
              .getState()
              .environments.find((e: { id: string }) => e.id === id)?.agentActivityState === wanted
          );
        },
        { id: environment.id, wanted },
      );
    const counters = async (): Promise<Record<string, number>> => {
      const response = await page.request.get(
        new URL("/__orkestrator/metrics", status.browserUrl).href,
      );
      if (!response.ok()) throw new Error("Gateway metrics unavailable");
      const raw = (await response.json()).commands;
      if (!raw || typeof raw !== "object") throw new Error("Gateway command counters unavailable");
      return Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [key, (value as { count: number }).count]),
      );
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 3_000));
    const cycles = [];
    await settle();
    let before = await counters();
    await settle();
    evidence.quiet = rpcDelta(before, await counters());
    for (let cycle = 1; cycle <= 2; cycle++) {
      const hold = `web3-${cycle}`;
      before = await counters();
      await composer.fill(`Reply with one word. [hold:${hold}]`);
      await composer.press("Enter");
      await waitFor("loopback model held", async () => model.held().includes(hold));
      await waitFor("renderer working", () => activity("working"));
      await settle();
      const working = await counters();
      model.release(hold);
      await waitFor("renderer idle", () => activity("idle"));
      await settle();
      const idle = await counters();
      cycles.push({
        cycle,
        idleToWorking: rpcDelta(before, working),
        workingToIdle: rpcDelta(working, idle),
      });
    }
    evidence.cycles = cycles;
    evidence.modelCalls = model.calls().length;
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message.split("\n")[0] : "Measurement failed";
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      browser?.close(),
      Promise.resolve().then(() => restore?.()),
      model.stop(),
    ]);
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length) {
      evidence.ok = false;
      evidence.cleanupErrors = failures.length;
    }
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
  }
  if (evidence.ok !== true) throw new Error("Measurement cleanup failed");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string) => args[args.indexOf(name) + 1];
  if (!args.includes("--profile") || !args.includes("--checkout") || !args.includes("--out"))
    throw new Error("Required: --profile NAME --checkout ABS --out FILE");
  await run(value("--profile")!, path.resolve(value("--checkout")!), value("--out")!);
}
