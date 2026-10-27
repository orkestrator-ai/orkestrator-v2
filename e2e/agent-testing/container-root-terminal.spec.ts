import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadAppWithDevRetry } from "./dev-startup-retry";

/**
 * A root terminal in the fixture container, opened from the real renderer
 * (**New root terminal**) against a profile started with
 * `--fixture-environments local,container`. The shell runs as uid 0, a
 * harmless command works, and outbound access follows the environment's
 * network mode: a host the restricted allowlist does not name is refused in a
 * restricted container (while GitHub, which it allows, answers) and reachable
 * in a full-network one (`--fixture-network full`).
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const environmentName =
  process.env.ORKESTRATOR_AGENT_TEST_ROOT_TERMINAL_ENVIRONMENT ?? "fixture-container";

type Status = { status: string; browserUrl: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function profileCommand<T>(command: string): T {
  const result = spawnSync("mise", ["run", command, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return JSON.parse(result.stdout) as T;
}

async function login(page: Page, testInfo: TestInfo, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const { loginUrl } = profileCommand<{ loginUrl?: unknown }>("dev:login");
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  await loadAppWithDevRetry(page, testInfo, () =>
    page.goto(loginUrl, { waitUntil: "domcontentloaded" }),
  );
  // The context's request client outlives the page, for cleanup after it closes.
  const request = page.context().request;
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await request.post(new URL("/__orkestrator/invoke", status.browserUrl).href, {
      data: { command, args },
    });
    expect(response.ok(), `${command} failed`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
}

/** Terminal output as plain text, without escape sequences. */
const visibleText = (output: string): string =>
  output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    // Two-character escapes, including the keypad modes (ESC = and ESC >).
    .replace(/\x1b[@-_=>]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");

test("Docker fixture root terminal runs as root and follows the network mode", async ({
  page,
}, testInfo) => {
  test.setTimeout(4 * 60_000);
  const status = profileCommand<Status>("dev:status");
  expect(status.status).toBe("ready");
  await page.setViewportSize({ width: 1280, height: 860 });
  const invoke = await login(page, testInfo, status);

  // The environment is found by name in any project, so a profile restarted
  // without re-seeding its fixture (no `testProject` in its status) works too.
  let environment:
    { id: string; name: string; containerId?: string; networkAccessMode?: string } | undefined;
  for (const project of await invoke<Array<{ id: string }>>("get_projects")) {
    environment = (
      await invoke<
        Array<{ id: string; name: string; containerId?: string; networkAccessMode?: string }>
      >("get_environments", { projectId: project.id })
    ).find((entry) => entry.name === environmentName);
    if (environment) break;
  }
  expect(environment?.containerId, `${environmentName} has no container`).toBeTruthy();
  const fullNetwork = environment!.networkAccessMode === "full";
  testInfo.annotations.push({
    type: "network",
    description: fullNetwork ? "full" : "restricted",
  });
  // The tab this test opens is removed afterwards by restoring the layout.
  const originalLayout = await invoke<unknown>("get_pane_layout", {
    environmentId: environment!.id,
  });

  try {
    const expand = page.getByRole("button", { name: /^Expand project / }).first();
    const collapse = page.getByRole("button", { name: /^Collapse project / }).first();
    await expect(expand.or(collapse)).toBeVisible({ timeout: 30_000 });
    if (await expand.isVisible()) await expand.click();
    const item = page.getByText(environmentName, { exact: true }).first();
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.click();

    // The renderer creates the root tab's session as the uid-0 `orkroot` user.
    const attached = page.waitForResponse(
      (response) => {
        if (!response.url().endsWith("/__orkestrator/invoke")) return false;
        try {
          const body = response.request().postDataJSON() as {
            command?: string;
            args?: { user?: string };
          };
          return body.command === "create_terminal_session" && body.args?.user === "orkroot";
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    );
    const rootTerminal = page.getByRole("button", { name: "New root terminal", exact: true });
    await expect(rootTerminal).toBeEnabled({ timeout: 60_000 });
    await rootTerminal.click();
    const sessionId = ((await (await attached).json()) as { result: { sessionId: string } }).result
      .sessionId;
    expect(sessionId).toContain(":");
    const output = async () =>
      visibleText(
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output,
      );
    // Wait for the shell's prompt (the image's zsh theme ends it with ❯) before
    // typing, so no input is lost to startup.
    await expect
      .poll(async () => /[#$%>\u276f]\s*$/.test((await output()).trimEnd()), { timeout: 60_000 })
      .toBe(true);
    // Keystrokes reach a session through `terminal_write`. Several terminals
    // can be visible (other panes), so focus each until one writes to ours.
    const writtenSessions: string[] = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/__orkestrator/invoke")) return;
      try {
        const body = request.postDataJSON() as {
          command?: string;
          args?: { sessionId?: string };
        };
        if (body.command === "terminal_write" && body.args?.sessionId) {
          writtenSessions.push(body.args.sessionId);
        }
      } catch {
        // Not a JSON command.
      }
    });
    const terminals = page.locator(".xterm:visible");
    await expect(terminals.first()).toBeVisible({ timeout: 30_000 });
    let focused = false;
    for (let index = (await terminals.count()) - 1; index >= 0 && !focused; index -= 1) {
      await terminals.nth(index).click();
      const before = writtenSessions.length;
      // A space is harmless at a prompt and is erased again below.
      await page.keyboard.press("Space");
      await expect.poll(() => writtenSessions.length, { timeout: 10_000 }).toBeGreaterThan(before);
      focused = writtenSessions.at(-1) === sessionId;
      await page.keyboard.press("Backspace");
    }
    expect(focused, "no visible terminal writes to the root session").toBe(true);

    const run = async (command: string, marker: RegExp, timeout = 60_000) => {
      await page.keyboard.type(command);
      await page.keyboard.press("Enter");
      let match: RegExpMatchArray | null = null;
      await expect
        .poll(
          async () => {
            match = (await output()).match(marker);
            return Boolean(match);
          },
          { timeout },
        )
        .toBe(true);
      return match! as RegExpMatchArray;
    };

    // Arithmetic in the command keeps the echoed input from matching the marker.
    const identity = await run(
      'echo "ROOT_$((1+1))_UID=$(id -u)_USER=$(id -un)_HOME=$HOME"',
      /ROOT_2_UID=(\d+)_USER=(\S+)_HOME=(\S+)/,
    );
    expect(identity[1], "root terminal uid").toBe("0");
    // A harmless command that needs root: write and remove a file under /root.
    await run(
      'f=/root/.orkestrator-root-check-$$; touch "$f" && rm "$f" && echo "WRITE_$((2+2))=ok"',
      /WRITE_4=ok/,
    );

    const probe = async (url: string, label: string) => {
      const result = await run(
        `curl -sS -o /dev/null --connect-timeout 8 --max-time 15 -w 'HTTP=%{http_code}\\n' ${url}; echo "${label}_$((3+3))_EXIT=$?"`,
        new RegExp(`${label}_6_EXIT=(\\d+)`),
        45_000,
      );
      return Number(result[1]);
    };
    const blocked = await probe("https://example.com", "BLOCKED");
    if (fullNetwork) {
      expect(blocked, "a full-network container reaches example.com").toBe(0);
    } else {
      expect(blocked, "a restricted container is refused example.com").not.toBe(0);
      // The allowlist still works, so the refusal is the policy, not a dead network.
      expect(await probe("https://github.com", "ALLOWED"), "github.com is allowed").toBe(0);
    }
  } finally {
    // Close the page first so the renderer cannot save its layout again, then
    // restore the original tabs, which drops the root tab this test opened.
    await page.close();
    const current = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: environment!.id,
    });
    if (current) {
      const restored = originalLayout as {
        version?: number;
        containerId?: string | null;
        activePaneId?: string;
        root?: unknown;
      } | null;
      await (restored?.root
        ? invoke("save_pane_layout", {
            environmentId: environment!.id,
            expectedRevision: current.revision ?? 0,
            layout: {
              version: restored.version,
              containerId: restored.containerId ?? null,
              activePaneId: restored.activePaneId,
              root: restored.root,
            },
          })
        : invoke("delete_pane_layout", {
            environmentId: environment!.id,
            expectedRevision: current.revision ?? 0,
          }));
    }
  }
});
