/**
 * A selected slash command in an inactive environment, against a real
 * `dev:test --fixture` profile and a real provider.
 *
 * Opt-in only: the commands run real model turns on the host's provider
 * credentials, so every case is skipped unless
 * `ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1`. `ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS`
 * picks the providers (comma-separated, default `codex`; `claude` is also
 * supported). Nothing at module scope spawns `mise` or reads profile state, so
 * the file stays inert in profile-free runs.
 *
 * Each case plants project commands in a disposable environment's worktree
 * (never this repository, never a provider home) and proves a command ran by a
 * nonce that exists only in the command file: the typed text never contains
 * it, so only the expanded command can produce it. The environments are
 * created with the execution-policy override `projectResources: true`, the
 * supported way to let a host session load project commands (Claude ignores
 * them otherwise).
 *
 * Codex tabs are launched on `ORKESTRATOR_AGENT_TEST_MODEL` (default
 * `gpt-6.1-sol`, as in the build-pipeline steering case): a new profile's
 * default Codex model is not offered to a ChatGPT login, and a stored model
 * missing from the catalogue still runs (tracked in
 * docs/todo/cli-and-slash-commands/0015-slash-command-qualification.md). Claude tabs use the profile's
 * default model.
 *
 * What it checks (docs/todo/cli-and-slash-commands/0015-slash-command-qualification.md, item 2):
 *
 * - A selected command sent just before switching away completes while its
 *   environment is inactive, through an inventory change, a catalogue refresh
 *   and a browser outage long enough to need reconciliation, and runs once.
 * - On return and after a hard reload: the result, the new inventory, a stale
 *   draft whose command disappeared (kept, refused, nothing sent) and the
 *   composer controls; then again in a narrow viewport.
 * - A bridge restart at two dispatch boundaries (right after Send, and while
 *   the accepted turn runs). A command may fail or park, but never run twice,
 *   including after a retry under the same request id.
 *
 * Bridge restarts use the profile's own per-environment stop and start
 * commands, so only this case's bridge is touched.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NativeAgentDispatchOutcome } from "@orkestrator/protocol/native-agent";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { dismissSidebarTooltip } from "./sidebar-tooltip";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Message = { role?: unknown; content?: unknown };
type Projection = {
  turn: { phase: string; error?: string };
  messages?: Message[];
  slashCommands?: Array<{ name: string }>;
  recoverableDispatch?: { requestId: string; status?: "reconciling" | "action-required" };
} | null;
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_SLASH === "1";
const NARROW_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1440, height: 1600 };

/**
 * Where each provider reads a project command, and how its catalogue picks up
 * a change. Codex rescans on an explicit refresh (`reloaded`). Claude does too
 * now that its CLI stays warm between turns (#1055); before that it answered
 * `deferred` and loaded changes only when its next turn started.
 */
const PROVIDERS = {
  codex: {
    label: "Codex",
    commandFile: (name: string) => `.codex/prompts/${name}.md`,
    refreshLoadsChanges: true,
    launchModel: process.env.ORKESTRATOR_AGENT_TEST_MODEL?.trim() || "gpt-6.1-sol",
  },
  claude: {
    label: "Claude",
    commandFile: (name: string) => `.claude/commands/${name}.md`,
    refreshLoadsChanges: true,
    launchModel: undefined,
  },
} as const;
type Provider = keyof typeof PROVIDERS;

function selectedProviders(): Provider[] {
  const raw = process.env.ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS?.trim() || "codex";
  return raw.split(",").map((value) => {
    const provider = value.trim();
    if (!(provider in PROVIDERS)) {
      throw new Error(
        `ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS: unsupported provider "${provider}" ` +
          `(supported: ${Object.keys(PROVIDERS).join(", ")})`,
      );
    }
    return provider as Provider;
  });
}

function profileStatus(): Status {
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

async function authenticatedInvoke(page: Page, status: Status): Promise<Invoke> {
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

function sidebarNavigator(page: Page, projectName: string) {
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

const textOf = (message: Message) => (typeof message.content === "string" ? message.content : "");
const count = (messages: Message[] | undefined, role: string, needle: string) =>
  (messages ?? []).filter((message) => message.role === role && textOf(message).includes(needle))
    .length;

/** Seven random digits: unique per run, and never part of anything typed. */
const nonce = (tag: string) => `${tag}-${Math.floor(1_000_000 + Math.random() * 9_000_000)}`;

function commandBody(description: string, instruction: string) {
  return `---\ndescription: ${description}\nargument-hint: <word>\n---\n${instruction}\n`;
}
const replyExactly = (token: string) =>
  `Reply with exactly the text ${token}-$ARGUMENTS and nothing else. Do not use any tools.`;

for (const provider of LIVE_OPT_IN ? selectedProviders() : (["codex"] as Provider[])) {
  const spec = PROVIDERS[provider];

  test.describe(`live slash commands in an inactive environment (${provider})`, () => {
    test.skip(
      !LIVE_OPT_IN,
      "opt-in live slash-command turns against the isolated fixture with host credentials",
    );

    test("a selected command completes while inactive, survives reload and restarts, and never runs twice", async ({
      page,
      context,
    }, testInfo) => {
      test.setTimeout(900_000);
      page.setDefaultTimeout(15_000);
      await page.setViewportSize(DESKTOP_VIEWPORT);
      // A dev profile's backend reports the Electron version as its own, so
      // every event-stream reconnect (this case forces one) raises the
      // "Reload to use the matching version" reminder over the composer's
      // Send button. Tapping the toast body dismisses it for the session.
      await page.addLocatorHandler(
        page.getByText("Reload to use the matching version."),
        async (reminder) => {
          await reminder.click();
        },
      );

      const status = profileStatus();
      expect(status.profile, "dev:status answered for a different profile").toBe(profile);
      expect(status.status, `profile "${profile}" is not running`).toBe("ready");
      expect(status.flavor).toBe("agent-test");
      const invoke = await authenticatedInvoke(page, status);
      const fixture = (await invoke<Project[]>("get_projects")).find(
        (project) => project.localPath === status.testProject,
      );
      expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();

      const environments: Environment[] = [];
      try {
        for (const name of [`slash-${provider}-a`, `slash-${provider}-b`]) {
          environments.push(
            await invoke<Environment>("create_environment", {
              projectId: fixture!.id,
              name: `${name}-${Date.now()}`,
              networkAccessMode: "restricted",
              environmentType: "local",
              agentSettings: { executionPolicy: { projectResources: true } },
            }),
          );
        }
        const [target, other] = environments as [Environment, Environment];
        await invoke("start_environment", { environmentId: target.id });
        const worktree = (
          await invoke<Environment>("get_environment", { environmentId: target.id })
        ).worktreePath;
        expect(worktree).toBeTruthy();
        const writeCommand = (name: string, body: string) => {
          const file = path.join(worktree!, spec.commandFile(name));
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, body);
        };
        const removeCommand = (name: string) =>
          rmSync(path.join(worktree!, spec.commandFile(name)), { force: true });

        const runToken = nonce("SLASHRUN");
        const addedToken = nonce("SLASHADDED");
        const longToken = nonce("SLASHLONG");
        const executionFile = `.slashq-executions-${longToken}`;
        // Append before any other work, once per command execution. A final
        // reply cannot prove at-most-once when a restart interrupts a turn.
        const recordExecution =
          "For every invocation of this command, including a retry with the same arguments, " +
          "as your first action use the shell tool exactly once to run " +
          `\`printf '%s\\n' '$ARGUMENTS' >> ${executionFile}\`. ` +
          "Always append a new line even if this file already has the same line. " +
          "Do not repeat that append or modify this file again within this invocation. Then ";
        const executions = (argument: string) =>
          existsSync(path.join(worktree!, executionFile))
            ? readFileSync(path.join(worktree!, executionFile), "utf8")
                .split("\n")
                .filter((line) => line === argument).length
            : 0;
        writeCommand("slashq-run", commandBody("Inactive qualification", replyExactly(runToken)));
        writeCommand(
          "slashq-long",
          commandBody(
            "Long qualification reply",
            recordExecution +
              "write every whole number from 1 to 400 in words, separated by commas, then on a " +
              `final line write exactly ${longToken}-$ARGUMENTS. Do not use any more tools.`,
          ),
        );
        writeCommand("slashq-gone", commandBody("Removed while inactive", replyExactly("GONE")));

        const tabId = `slash-${provider}-tab`;
        const sessionKey = `env-${target.id}:${tabId}`;
        const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
          environmentId: target.id,
        });
        await invoke("save_pane_layout", {
          environmentId: target.id,
          expectedRevision: layout?.revision ?? 0,
          layout: {
            version: PANE_LAYOUT_VERSION,
            containerId: null,
            activePaneId: "pane-slash",
            root: {
              kind: "leaf",
              id: "pane-slash",
              activeTabId: tabId,
              tabs: [
                {
                  id: tabId,
                  type: "agent-native",
                  nativeAgentData: { environmentId: target.id, platform: provider, isLocal: true },
                  ...(spec.launchModel ? { initialAgentModel: spec.launchModel } : {}),
                },
              ],
            },
          },
        });

        const identity = {
          environmentId: target.id,
          agent: provider,
          logicalSessionKey: sessionKey,
        };
        const projection = () => invoke<Projection>("get_native_agent_projection", identity);
        const hasRow = async (name: string) =>
          ((await projection())?.slashCommands ?? []).some((row) => row.name === name);
        const settled = async () => {
          const current = await projection();
          const phase = current?.turn.phase;
          return (phase === "idle" || phase === "error") && !current?.recoverableDispatch;
        };

        const openEnvironment = sidebarNavigator(page, fixture!.name);
        const composeBar = page.getByTestId("shared-native-compose-bar");
        const input = composeBar.getByRole("textbox", { name: `Message ${spec.label}` });
        const send = composeBar.getByRole("button", { name: "Send", exact: true });
        const picker = page.getByRole("listbox", { name: "Slash commands" });
        /**
         * Replace the composer's text. Right after a load or an environment
         * switch the composer may still be hydrating its saved draft, which
         * can swallow or overwrite early keystrokes, so retry until the text
         * is really there.
         */
        const typeIntoComposer = async (text: string) => {
          await expect(input).toBeVisible({ timeout: 90_000 });
          await expect(async () => {
            await input.click();
            await input.fill("");
            await page.keyboard.type(text);
            await expect(input).toHaveText(text, { timeout: 2_000 });
          }).toPass({ timeout: 30_000 });
        };
        /**
         * Send the draft from the keyboard. Persistent toasts (a provider's MCP
         * sign-in notice, the dev version reminder) can sit over the Send
         * button, so the button is only checked, not clicked.
         */
        const sendDraft = async () => {
          await expect(send).toBeEnabled({ timeout: 30_000 });
          await input.press("Enter");
        };
        /** Type a command name, choose its row from the picker, then type its arguments. */
        const selectCommand = async (name: string, args: string) => {
          await typeIntoComposer(name);
          const row = picker.getByRole("option", { name: new RegExp(`^${name}\\b`) });
          await expect(row).toBeVisible({ timeout: 30_000 });
          await row.click();
          await expect(picker).toBeHidden();
          await expect(input).toHaveText(`${name} `);
          await page.keyboard.type(args);
        };

        await page.goto(status.browserUrl!);
        await openEnvironment(target.name);
        // The tab creates its session on mount; wait for the planted rows.
        await expect
          .poll(() => hasRow("/slashq-run"), { timeout: 120_000, message: "cold discovery" })
          .toBe(true);

        await test.step("a command sent just before switching away completes while inactive", async () => {
          await selectCommand("/slashq-run", "alpha");
          await sendDraft();
          // Leave before the backend has necessarily accepted it.
          await openEnvironment(other.name);
          await expect(input).toBeHidden();

          // While inactive: an inventory change, a browser outage long enough
          // to need reconciliation, and a catalogue refresh.
          writeCommand(
            "slashq-added",
            commandBody(
              "Added while inactive",
              recordExecution + `reply with exactly ${addedToken}-$ARGUMENTS and nothing else.`,
            ),
          );
          removeCommand("slashq-gone");
          await context.setOffline(true);
          await page.waitForTimeout(10_000);
          await context.setOffline(false);
          await expect
            .poll(
              async () =>
                (await settled()) &&
                count((await projection())?.messages, "assistant", `${runToken}-alpha`),
              {
                timeout: 180_000,
                message: "the command never completed while inactive",
              },
            )
            .toBe(1);
          const refresh = await invoke<{ outcome: string }>(
            "refresh_native_agent_commands",
            identity,
          );
          expect(refresh.outcome).toBe(spec.refreshLoadsChanges ? "reloaded" : "deferred");
          if (spec.refreshLoadsChanges) {
            expect(await hasRow("/slashq-added")).toBe(true);
            expect(await hasRow("/slashq-gone")).toBe(false);
          }
        });

        await test.step("returning shows the result, the new inventory and usable controls", async () => {
          await openEnvironment(target.name);
          await expect(page.getByText(`${runToken}-alpha`).first()).toBeVisible({
            timeout: 30_000,
          });
          await expect(composeBar.getByTitle("Stop current query")).toBeHidden();
          if (spec.refreshLoadsChanges) {
            await typeIntoComposer("/slashq-");
            await expect(picker.getByRole("option", { name: /^\/slashq-added\b/ })).toBeVisible();
            await expect(picker.getByRole("option", { name: /^\/slashq-gone\b/ })).toHaveCount(0);
            await page.keyboard.press("Escape");
            await input.fill("");
          }
          // Exactly once, from the backend's own record.
          const messages = (await projection())?.messages;
          expect(count(messages, "assistant", `${runToken}-alpha`)).toBe(1);
          expect(count(messages, "user", "/slashq-run alpha")).toBe(1);
        });

        await test.step("a stale draft is kept and refused, and nothing is sent", async () => {
          if (!spec.refreshLoadsChanges) {
            testInfo.annotations.push({
              type: "skip-step",
              description: `${provider} loads a removed command only at its next turn; stale drafts are checked on Codex`,
            });
            return;
          }
          writeCommand("slashq-gone", commandBody("Removed while inactive", replyExactly("GONE")));
          await invoke("refresh_native_agent_commands", identity);
          await page.reload();
          await openEnvironment(target.name);
          await selectCommand("/slashq-gone", "beta");
          await openEnvironment(other.name);
          removeCommand("slashq-gone");
          const refresh = await invoke<{ outcome: string }>(
            "refresh_native_agent_commands",
            identity,
          );
          expect(refresh.outcome).toBe("reloaded");
          expect(await hasRow("/slashq-gone")).toBe(false);
          const before = (await projection())?.messages?.length ?? 0;
          await openEnvironment(target.name);
          await expect(input).toHaveText("/slashq-gone beta", { timeout: 30_000 });
          await sendDraft();
          await expect(
            page.getByText(
              "The selected command is no longer available. Choose it again from the menu.",
            ),
          ).toBeVisible();
          await expect(input).toHaveText("/slashq-gone beta");
          expect((await projection())?.messages?.length ?? 0).toBe(before);
          expect(count((await projection())?.messages, "user", "/slashq-gone")).toBe(0);
          await input.fill("");
        });

        await test.step("the result and the new inventory survive a hard reload", async () => {
          if (!spec.refreshLoadsChanges) {
            // Claude reads changed commands when its next turn starts.
            await selectCommand("/slashq-run", "nudge");
            await sendDraft();
            await expect
              .poll(
                async () => count((await projection())?.messages, "assistant", `${runToken}-nudge`),
                {
                  timeout: 180_000,
                },
              )
              .toBe(1);
            await expect
              .poll(() => hasRow("/slashq-added"), {
                timeout: 90_000,
                message: "new command after a turn",
              })
              .toBe(true);
          }
          await page.reload();
          await openEnvironment(target.name);
          await expect(page.getByText(`${runToken}-alpha`).first()).toBeVisible({
            timeout: 30_000,
          });
          await typeIntoComposer("/slashq-add");
          await expect(picker.getByRole("option", { name: /^\/slashq-added\b/ })).toBeVisible({
            timeout: 30_000,
          });
          await page.keyboard.press("Escape");
          await input.fill("");
        });

        await test.step("narrow viewport: the result and the picker stay usable", async () => {
          await page.setViewportSize(NARROW_VIEWPORT);
          await page.reload();
          await openEnvironment(target.name);
          await expect(page.getByText(`${runToken}-alpha`).first()).toBeVisible({
            timeout: 30_000,
          });
          await expect(input).toBeVisible({ timeout: 30_000 });
          await typeIntoComposer("/slashq-add");
          const row = picker.getByRole("option", { name: /^\/slashq-added\b/ });
          await expect(row).toBeVisible({ timeout: 30_000 });
          await expect(row).toBeInViewport();
          await page.keyboard.press("Escape");
          await input.fill("");
          await page.setViewportSize(DESKTOP_VIEWPORT);
          await page.reload();
          await openEnvironment(target.name);
        });

        /**
         * Restart this environment's bridge at a dispatch boundary, then settle.
         * A parked dispatch is retried under its own request id, which must
         * not run the command a second time.
         */
        const restartBridge = async () => {
          await invoke(`stop_local_${provider}_server_cmd`, { environmentId: target.id });
          await invoke(`start_local_${provider}_server_cmd`, { environmentId: target.id });
          await invoke("await_bridge_ready", {
            environmentId: target.id,
            agent: provider,
            timeoutMs: 60_000,
          });
        };
        const sendRestartDraft = async (typed: string) => {
          const submitted = page.waitForRequest((request) => {
            if (request.method() !== "POST" || !request.url().endsWith("/__orkestrator/invoke"))
              return false;
            const body = request.postDataJSON() as {
              command?: string;
              args?: Record<string, unknown>;
            };
            return body.command === "dispatch_native_agent_intent" && body.args?.prompt === typed;
          });
          await sendDraft();
          const body = (await submitted).postDataJSON() as { args: Record<string, unknown> };
          expect(typeof body.args.requestId).toBe("string");
          return body.args;
        };
        const settleAfterRestart = async (typed: string) => {
          let retried = false;
          await expect
            .poll(
              async () => {
                const current = await projection();
                const parked = current?.recoverableDispatch;
                if (parked?.status === "action-required" && !retried) {
                  retried = true;
                  testInfo.annotations.push({
                    type: "parked",
                    description: `${typed}: parked after the restart; retried under the same request id`,
                  });
                  const outcome = await invoke<NativeAgentDispatchOutcome>(
                    "retry_native_agent_dispatch",
                    { ...identity, requestId: parked.requestId },
                  );
                  // A restarted bridge cannot say whether an earlier process ran
                  // the id. It must say so, never a generic error or "accepted"
                  // for a turn that never ran, and the card must not stay up.
                  if (outcome.outcome === "rejected") {
                    expect(outcome, `${typed}: retry refused without saying why`).toMatchObject({
                      requestIdRetired: true,
                      error: expect.stringMatching(
                        /could not confirm this message, so it may not have run/,
                      ),
                    });
                  }
                  testInfo.annotations.push({
                    type: "retry-outcome",
                    description: `${typed}: ${outcome.outcome}${outcome.outcome === "rejected" && outcome.requestIdRetired ? " (retired)" : ""}`,
                  });
                  return false;
                }
                return settled();
              },
              {
                timeout: 240_000,
                intervals: [2_000],
                message: `${typed} never settled after the restart`,
              },
            )
            .toBe(true);
          return retried;
        };
        /**
         * Count from the backend once the tab is back. A restarted bridge may
         * not hold an unmounted session's transcript, so first prove the
         * transcript is loaded (the first command's reply is in it); a count
         * of zero is otherwise meaningless.
         */
        const expectAtMostOnce = async (token: string, typed: string, retried: boolean) => {
          await expect
            .poll(
              async () => count((await projection())?.messages, "assistant", `${runToken}-alpha`),
              {
                timeout: 90_000,
                message: "the transcript never reloaded after the restart",
              },
            )
            .toBe(1);
          // Long enough for a duplicate re-dispatch to surface if one existed.
          await page.waitForTimeout(15_000);
          const messages = (await projection())?.messages;
          const replies = count(messages, "assistant", token);
          expect(replies, `${typed} produced duplicate final replies`).toBeLessThanOrEqual(1);
          expect(
            count(messages, "user", typed),
            `${typed} was submitted more than once`,
          ).toBeLessThanOrEqual(1);
          testInfo.annotations.push({
            type: "restart-outcome",
            description: `${typed}: ${replies === 1 ? "one final reply" : "no final reply"}${retried ? " (after retry)" : ""}`,
          });
          return replies;
        };

        await test.step("a bridge restart right after Send never runs the command twice", async () => {
          await selectCommand("/slashq-added", "gamma");
          const submission = await sendRestartDraft("/slashq-added gamma");
          await restartBridge();
          await openEnvironment(other.name);
          const retried = await settleAfterRestart("/slashq-added gamma");
          // Replay the actual browser submission even when reconciliation
          // did not park it. This always exercises same-id retry admission.
          await invoke("dispatch_native_agent_intent", submission);
          await settleAfterRestart("/slashq-added gamma");
          await openEnvironment(target.name);
          await expect(input).toBeVisible({ timeout: 90_000 });
          await expect(composeBar.getByTitle("Stop current query")).toBeHidden({ timeout: 30_000 });
          await expectAtMostOnce(`${addedToken}-gamma`, "/slashq-added gamma", retried);
          expect(
            executions("gamma"),
            "restart after Send duplicated execution",
          ).toBeLessThanOrEqual(1);
        });

        await test.step("a bridge restart while the accepted command runs never runs it twice", async () => {
          await selectCommand("/slashq-long", "delta");
          const submission = await sendRestartDraft("/slashq-long delta");
          await expect
            .poll(async () => (await projection())?.turn.phase, {
              timeout: 90_000,
              message: "the long command never started running",
            })
            .toBe("running");
          await expect
            .poll(() => executions("delta"), {
              timeout: 90_000,
              message: "the long command never durably recorded its start",
            })
            .toBe(1);
          expect((await projection())?.turn.phase, "restart must interrupt a running command").toBe(
            "running",
          );
          await openEnvironment(other.name);
          await restartBridge();
          const retried = await settleAfterRestart("/slashq-long delta");
          await invoke("dispatch_native_agent_intent", submission);
          await settleAfterRestart("/slashq-long delta");
          await openEnvironment(target.name);
          await expect(input).toBeVisible({ timeout: 90_000 });
          await expect(composeBar.getByTitle("Stop current query")).toBeHidden({ timeout: 30_000 });
          await expectAtMostOnce(`${longToken}-delta`, "/slashq-long delta", retried);
          expect(executions("delta"), "restart or same-id retry duplicated execution").toBe(1);
          // The session still runs commands afterwards.
          await selectCommand("/slashq-run", "omega");
          await sendDraft();
          await expect
            .poll(
              async () => count((await projection())?.messages, "assistant", `${runToken}-omega`),
              {
                timeout: 180_000,
              },
            )
            .toBe(1);
          await expect(page.getByText(`${runToken}-omega`).first()).toBeVisible({
            timeout: 30_000,
          });
        });
      } finally {
        await context.setOffline(false).catch(() => undefined);
        for (const created of environments) {
          await invoke("stop_environment", { environmentId: created.id }).catch(() => undefined);
          await invoke("delete_environment", { environmentId: created.id }).catch(() => undefined);
        }
      }
    });
  });
}
