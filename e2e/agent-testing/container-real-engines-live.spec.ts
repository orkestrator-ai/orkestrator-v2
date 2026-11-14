import { expect, test, type Page, type TestInfo } from "./browser-test";
import {
  containerName,
  fixtureEnvironment,
  inContainer,
  invoke,
  login,
  reloadApp,
  selectEnvironment,
  type Environment,
} from "./container-wiring-support";
import {
  ALLOWED_URL,
  BLOCKED_URL,
  approveFromCard,
  curlCommand,
  entryDirectory,
  expectContainerPolicy,
  requireCellPlatform,
  restoreLayout,
  restoreRealBridge,
  saveSingleTabLayout,
  sendPrompt,
  tabSession,
  waitForPendingInteraction,
  type CellMessage,
  type PaneLayout,
  type Platform,
  type Projection,
} from "./container-engine-cells-support";
import {
  LIVE_CURSOR_SWITCH,
  LIVE_PI_MODEL,
  curlCallFor,
  isReached,
  isRefused,
  liveContainerCellSettings,
  resolveShellToolOutputs,
  shellToolCalls,
  shellToolPrompt,
} from "./container-real-engines-live-support";

/**
 * Real-provider variants of the Cursor and Pi cells of the Docker fixture
 * (to-do 7040 (retired), tasks 1 and 2). `container-fake-engines.spec.ts`
 * proves the bridge, the production container launch, the policy, the
 * firewall and Pi's `ask` card over fake engines. These run the image's own
 * bridge, unchanged, over the real Cursor SDK and a real Pi provider, so
 * what they add is the vendor's own process tree and network reach and the
 * model's choice of tool.
 *
 * Both are skipped by default and need a login and billed turns:
 * - Cursor: `ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_CURSOR=1` (optionally
 *   `..._CURSOR_MODEL`), profile started with `--credential-source cursor`.
 *   The model runs `curl` through its Shell tool; the SDK local agent runs
 *   it in the bridge's process tree, so the container firewall must refuse
 *   `example.com` and let GitHub answer.
 * - Pi: `ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_PI_MODEL=<provider/modelId>`
 *   on a provider the profile is signed in to (`--credential-source pi`).
 *   The same `curl` through Pi's `bash` tool under `auto-approve`, then a
 *   command under `ask` that must not run until its card is approved. The
 *   provider's own host has to be on the container's allowlist; if it is not,
 *   the first turn fails with the provider's error.
 *
 * The backend stages each platform's credential into the container on every
 * bridge start; nothing here reads or copies one. Profile:
 * `--fixture-environments local,container` with the platform in
 * `--agent-platforms`; the manual-test checklist (7568, 7040 tasks 1 and 2)
 * has the commands.
 */

// Backend calls carry the disposable profile's token; keep it out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const settings = liveContainerCellSettings(process.env);
const SHELL_TOOLS: Record<Platform, { names: string[]; prompted: string }> = {
  cursor: { names: ["shell"], prompted: "Shell" },
  pi: { names: ["bash"], prompted: "bash" },
};

type Session = ReturnType<typeof tabSession>;

async function openRealCell(
  page: Page,
  testInfo: TestInfo,
  platform: Platform,
): Promise<{ environment: Environment; containerId: string; cleanup: () => Promise<void> }> {
  await requireCellPlatform(platform);
  const environment = await fixtureEnvironment(containerName);
  const containerId = environment.containerId;
  if (!containerId) throw new Error(`${containerName} has no container`);
  const previousLayout = await invoke<PaneLayout | null>("get_pane_layout", {
    environmentId: environment.id,
  });
  const previousSettings =
    (await invoke<Environment & { agentSettings?: unknown }>("get_environment", {
      environmentId: environment.id,
    }).then((stored) => stored.agentSettings)) ?? null;
  const args = { containerId };
  const cleanup = async () => {
    try {
      await page.goto("about:blank").catch(() => undefined);
      await restoreLayout(environment, containerId, previousLayout);
      await invoke("update_environment_agent_settings", {
        environmentId: environment.id,
        agentSettings: previousSettings,
      });
    } finally {
      await invoke(`stop_${platform}_server`, args);
    }
  };
  // A bridge left running (a fake cell's included) would be reused as is.
  await invoke(`stop_${platform}_server`, args);
  try {
    // A fake cell stopped before its cleanup must not stand in for the SDK.
    restoreRealBridge(containerId, platform);
    const dist = entryDirectory(platform);
    expect(
      inContainer(containerId, `test ! -e ${dist}/index.js.qa-real && echo image`, {
        user: "root",
      }),
    ).toContain("image");
    await page.setViewportSize({ width: 1400, height: 900 });
    await login(page, testInfo);
    return { environment, containerId, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Cell setup and rollback failed");
    }
    throw error;
  }
}

/**
 * Waits for the turn `previous` was taken before to settle with a new reply,
 * and returns the turn's new rows. A real turn spans several rows (one per
 * model response), so the tool card is looked for across all of them.
 */
async function waitForTurnEnd(
  session: Session,
  previous: ReadonlySet<string>,
): Promise<CellMessage[]> {
  let rows: CellMessage[] = [];
  await expect
    .poll(
      async () => {
        const current: Projection = await session.projection();
        if (current?.turn.phase === "error") {
          throw new Error(
            `${session.label} turn failed: ${current.turn.error ?? "no error"} ` +
              "(a sign-in error or a provider host missing from the allowlist shows here)",
          );
        }
        if (current?.turn.phase !== "idle") return false;
        rows = current.messages.filter((message) => !previous.has(message.id));
        // The prompt's own row first, then a reply after it: an idle phase
        // read before the turn started has neither.
        const prompted = rows.findIndex((message) => message.role === "user");
        return (
          prompted !== -1 &&
          rows.slice(prompted + 1).some((message) => message.role === "assistant")
        );
      },
      { timeout: settings.turnTimeoutMs, message: `${session.label} never finished its turn` },
    )
    .toBe(true);
  return rows;
}

/** Asks the model to `curl` one URL through its shell tool; returns the card's outcome. */
async function curlThroughShellTool(
  page: Page,
  testInfo: TestInfo,
  platform: Platform,
  session: Session,
  url: string,
) {
  const tool = SHELL_TOOLS[platform];
  const previous = await sendPrompt(
    page,
    session.label,
    session.projection,
    shellToolPrompt(tool.prompted, curlCommand(url)),
  );
  const rows = await waitForTurnEnd(session, previous);
  // The projection keeps each card's output behind its detailRef.
  const calls = await resolveShellToolOutputs(
    shellToolCalls(rows, tool.names),
    session.toolDetails,
  );
  const call = curlCallFor(calls, url);
  // Content-free evidence: the tool, the HTTP status and curl's exit code.
  testInfo.annotations.push({
    type: `${platform}-shell-${url === BLOCKED_URL ? "blocked" : "allowed"}`,
    description: JSON.stringify(
      call ? { tool: call.toolName, ...call.outcome } : { calls: calls.length, found: false },
    ),
  });
  expect(
    call,
    `${session.label} did not run curl against ${url} through its ${tool.prompted} tool ` +
      `(${calls.length} ${tool.names.join("/")} call(s) in the turn)`,
  ).toBeTruthy();
  return call!.outcome;
}

test("Docker fixture real Cursor cell runs its Shell tool under the container firewall (opt-in, billed)", async ({
  page,
}, testInfo) => {
  test.skip(
    !settings.cursor.optedIn,
    `Set ${LIVE_CURSOR_SWITCH}=1 with a Cursor login (--credential-source cursor); a billed turn`,
  );
  test.setTimeout(settings.turnTimeoutMs * 3 + 180_000);
  const { environment, containerId, cleanup } = await openRealCell(page, testInfo, "cursor");
  try {
    const tabId = `cursor-real-cell-${Date.now()}`;
    await saveSingleTabLayout(environment, containerId, "cursor", tabId, settings.cursor.model);
    await reloadApp(page, testInfo);
    await selectEnvironment(page, containerName);
    const session = tabSession(environment, "cursor", tabId);

    await test.step("the Shell tool is refused off the allowlist", async () => {
      const blocked = await curlThroughShellTool(page, testInfo, "cursor", session, BLOCKED_URL);
      expect(isRefused(blocked), "example.com answered from Cursor's Shell tool").toBe(true);
      expectContainerPolicy((await session.projection())?.policy, "auto-approve");
    });

    await test.step("the same Shell tool reaches GitHub", async () => {
      const allowed = await curlThroughShellTool(page, testInfo, "cursor", session, ALLOWED_URL);
      expect(isReached(allowed), "GitHub did not answer Cursor's Shell tool").toBe(true);
    });
  } finally {
    await cleanup();
  }
});

test("Docker fixture real Pi cell runs its bash tool under the container firewall and approvals (opt-in, billed)", async ({
  page,
}, testInfo) => {
  test.skip(
    !settings.pi.optedIn,
    `Set ${LIVE_PI_MODEL}=<provider/modelId> on a provider the profile is signed in to; billed turns`,
  );
  if (settings.pi.problem) throw new Error(settings.pi.problem);
  test.setTimeout(settings.turnTimeoutMs * 4 + 240_000);
  const { environment, containerId, cleanup } = await openRealCell(page, testInfo, "pi");
  try {
    const firstTab = `pi-real-cell-${Date.now()}`;
    await saveSingleTabLayout(environment, containerId, "pi", firstTab, settings.pi.model);
    await reloadApp(page, testInfo);
    await selectEnvironment(page, containerName);
    const first = tabSession(environment, "pi", firstTab);

    await test.step("under auto-approve, bash is refused off the allowlist and reaches GitHub", async () => {
      const blocked = await curlThroughShellTool(page, testInfo, "pi", first, BLOCKED_URL);
      expect(isRefused(blocked), "example.com answered from Pi's bash tool").toBe(true);
      expectContainerPolicy((await first.projection())?.policy, "auto-approve");
      const allowed = await curlThroughShellTool(page, testInfo, "pi", first, ALLOWED_URL);
      expect(isReached(allowed), "GitHub did not answer Pi's bash tool").toBe(true);
    });

    await test.step("under ask, the call parks a card and runs only once approved", async () => {
      await invoke("update_environment_agent_settings", {
        environmentId: environment.id,
        agentSettings: {
          executionPolicy: { approvals: "ask", sandbox: "container", networkAccess: "restricted" },
        },
      });
      // A new tab: the policy is fixed when a session is created.
      const askTab = `pi-real-cell-ask-${Date.now()}`;
      await saveSingleTabLayout(environment, containerId, "pi", askTab, settings.pi.model);
      await reloadApp(page, testInfo);
      await selectEnvironment(page, containerName);
      const asking = tabSession(environment, "pi", askTab);
      const marker = `/tmp/orkestrator-qa-pi-real-approved-${Date.now()}`;
      const command = `touch ${marker} && echo approved`;
      try {
        const previous = await sendPrompt(
          page,
          asking.label,
          asking.projection,
          shellToolPrompt("bash", command),
        );
        const pending = await waitForPendingInteraction(
          asking.projection,
          "Pi never asked to run the command",
          settings.turnTimeoutMs,
        );
        expectContainerPolicy((await asking.projection())?.policy, "ask");
        // Parked, not run: the gate holds the call inside the container.
        expect(inContainer(containerId, `test -e ${marker} && echo ran || echo held`).trim()).toBe(
          "held",
        );
        await approveFromCard(page, pending);
        const rows = await waitForTurnEnd(asking, previous);
        const call = (
          await resolveShellToolOutputs(
            shellToolCalls(rows, SHELL_TOOLS.pi.names).filter((candidate) =>
              candidate.command.includes(marker),
            ),
            asking.toolDetails,
          )
        )[0];
        testInfo.annotations.push({
          type: "pi-ask",
          description: JSON.stringify({
            found: Boolean(call),
            approved: call?.output.includes("approved"),
          }),
        });
        expect(call, "Pi did not run the approved command through bash").toBeTruthy();
        expect(call!.output).toContain("approved");
        expect(inContainer(containerId, `test -e ${marker} && echo ran || echo held`).trim()).toBe(
          "ran",
        );
      } finally {
        inContainer(containerId, `rm -f ${marker}`);
      }
    });
  } finally {
    await cleanup();
  }
});
