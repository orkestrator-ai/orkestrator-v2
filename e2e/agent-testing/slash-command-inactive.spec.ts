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
 * Each case plants project commands in a disposable environment's workspace
 * (never this repository, never a provider home) and proves a command ran by a
 * nonce that exists only in the command file: the typed text never contains
 * it, so only the expanded command can produce it. No case writes a
 * user-scope command file.
 *
 * `ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT` picks where the commands run:
 *
 * - `local` (default): a host worktree, written directly. The environment is
 *   created with the execution-policy override `projectResources: true`, the
 *   supported way to let a host session load project commands (Claude ignores
 *   them otherwise).
 * - `container`: a containerized environment; the profile must have been
 *   started with `--fixture-environments local,container` so its image
 *   exists. The workspace is the container's own `/workspace` (a clone, not a
 *   host mount) and the bridge runs inside the container, so every command
 *   file and the execution marker are written, removed and read through
 *   `docker exec` as the container's `node` user, never on the host. No
 *   policy override is set: a container loads project resources by default,
 *   and that default is what this variant qualifies. Bridge restarts use the
 *   container bridge commands (`stop_<provider>_server`/`start_<provider>_server`).
 *   The environment the case switches away to stays a host environment that is
 *   never started; it is only somewhere else to be.
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
 *   and a 10 s browser outage that really drops the page's event stream
 *   (offline plus `window.stop()`, see `event-stream-outage.ts`), and runs
 *   once. The page must then reconnect its stream.
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
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { NativeAgentDispatchOutcome } from "@orkestrator/protocol/native-agent";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { watchEventStream } from "./event-stream-outage";
import {
  authenticatedInvoke,
  containerWorkspace,
  hostWorkspace,
  profileStatus,
  repositoryRoot,
  sidebarNavigator,
  type Environment,
  type Project,
} from "./slash-command-live-support";

type Message = { role?: unknown; content?: unknown };
type Projection = {
  turn: { phase: string; error?: string };
  messages?: Message[];
  slashCommands?: Array<{ name: string }>;
  recoverableDispatch?: { requestId: string; status?: "reconciling" | "action-required" };
  retiredDispatch?: { requestId: string; message: string };
} | null;

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

const ENVIRONMENT_KINDS = ["local", "container"] as const;
type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

function selectedEnvironmentKind(): EnvironmentKind {
  const raw = process.env.ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT?.trim() || "local";
  if (!(ENVIRONMENT_KINDS as readonly string[]).includes(raw)) {
    throw new Error(
      `ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT: unsupported environment "${raw}" ` +
        `(supported: ${ENVIRONMENT_KINDS.join(", ")})`,
    );
  }
  return raw as EnvironmentKind;
}
const ENVIRONMENT_KIND: EnvironmentKind = LIVE_OPT_IN ? selectedEnvironmentKind() : "local";

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

  test.describe(`live slash commands in an inactive ${ENVIRONMENT_KIND} environment (${provider})`, () => {
    test.skip(
      !LIVE_OPT_IN,
      "opt-in live slash-command turns against the isolated fixture with host credentials",
    );

    test("a selected command completes while inactive, survives reload and restarts, and never runs twice", async ({
      page,
      context,
    }, testInfo) => {
      const container = ENVIRONMENT_KIND === "container";
      // A container's first start clones the workspace and runs its setup.
      test.setTimeout(container ? 1_200_000 : 900_000);
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

      const status = profileStatus(profile);
      expect(status.profile, "dev:status answered for a different profile").toBe(profile);
      expect(status.status, `profile "${profile}" is not running`).toBe("ready");
      expect(status.flavor).toBe("agent-test");
      const invoke = await authenticatedInvoke(page, status, profile);
      const fixture = (await invoke<Project[]>("get_projects")).find(
        (project) => project.localPath === status.testProject,
      );
      expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();

      const environments: Environment[] = [];
      try {
        const localSettings = {
          environmentType: "local",
          agentSettings: { executionPolicy: { projectResources: true } },
        };
        for (const [name, settings] of [
          // A container loads project resources by default; no override.
          [`slash-${provider}-a`, container ? { environmentType: "containerized" } : localSettings],
          [`slash-${provider}-b`, localSettings],
        ] as const) {
          environments.push(
            await invoke<Environment>("create_environment", {
              projectId: fixture!.id,
              name: `${name}-${Date.now()}`,
              networkAccessMode: "restricted",
              ...settings,
            }),
          );
        }
        const [target, other] = environments as [Environment, Environment];
        await invoke("start_environment", { environmentId: target.id });
        let started = await invoke<Environment>("get_environment", { environmentId: target.id });
        if (container) {
          // Start returns once setup is launched; the clone lands later.
          await expect
            .poll(
              async () => {
                started = await invoke<Environment>("get_environment", {
                  environmentId: target.id,
                });
                return (
                  started.status === "running" &&
                  !!started.containerId &&
                  started.setupPhase !== "pending" &&
                  started.setupPhase !== "running"
                );
              },
              { timeout: 300_000, intervals: [2_000], message: "the container never started" },
            )
            .toBe(true);
          expect(started.environmentType).toBe("containerized");
          expect(started.setupPhase, "container setup failed").not.toBe("failed");
        } else {
          expect(started.worktreePath).toBeTruthy();
        }
        const containerId = container ? started.containerId! : null;
        const workspace = container
          ? containerWorkspace(containerId!)
          : hostWorkspace(started.worktreePath!);
        const writeCommand = (name: string, body: string) =>
          workspace.write(spec.commandFile(name), body);
        const removeCommand = (name: string) => workspace.remove(spec.commandFile(name));

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
          (workspace.read(executionFile) ?? "").split("\n").filter((line) => line === argument)
            .length;
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
            containerId,
            activePaneId: "pane-slash",
            root: {
              kind: "leaf",
              id: "pane-slash",
              activeTabId: tabId,
              tabs: [
                {
                  id: tabId,
                  type: "agent-native",
                  nativeAgentData: {
                    environmentId: target.id,
                    platform: provider,
                    ...(containerId ? { containerId } : {}),
                    isLocal: !container,
                  },
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
        const stream = watchEventStream(page);
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

        await test.step("composer clicks keep the picker open and clearing resets dismissal", async () => {
          // The same 30 s budget as every other picker wait here: a container
          // tab can take longer to apply its first catalogue (flake 0710).
          await typeIntoComposer("/slashq-run");
          await expect(picker).toBeVisible({ timeout: 30_000 });
          await input.click();
          await expect(picker).toBeVisible();
          await input.press("Escape");
          await expect(picker).toBeHidden();
          await typeIntoComposer("/slashq-run");
          await expect(picker).toBeVisible({ timeout: 30_000 });
          await input.press("Escape");
          await input.fill("");
        });

        await test.step("a command sent just before switching away completes while inactive", async () => {
          await selectCommand("/slashq-run", "alpha");
          await sendDraft();
          // Leave before the backend has necessarily accepted it.
          await openEnvironment(other.name);
          await expect(input).toBeHidden();

          // While inactive: an inventory change, a browser outage that drops
          // the event stream (offline alone leaves it connected), and a
          // catalogue refresh. Whatever the page missed meanwhile must come
          // back through reconnection and replay.
          writeCommand(
            "slashq-added",
            commandBody(
              "Added while inactive",
              recordExecution + `reply with exactly ${addedToken}-$ARGUMENTS and nothing else.`,
            ),
          );
          removeCommand("slashq-gone");
          const outageStartedAt = Date.now();
          await stream.cut(context);
          await page.waitForTimeout(Math.max(0, 10_000 - (Date.now() - outageStartedAt)));
          await context.setOffline(false);
          await stream.expectReconnected();
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
          // The refusal is the dispatch's own answer: the backend revalidates
          // the selection against the bridge, which takes seconds in a busy
          // container.
          await expect(
            page.getByText(
              "The selected command is no longer available. Choose it again from the menu.",
            ),
          ).toBeVisible({ timeout: 30_000 });
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
          if (containerId) {
            await invoke(`stop_${provider}_server`, { containerId });
            await invoke(`start_${provider}_server`, { containerId });
          } else {
            await invoke(`stop_local_${provider}_server_cmd`, { environmentId: target.id });
            await invoke(`start_local_${provider}_server_cmd`, { environmentId: target.id });
          }
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
        const settleAfterRestart = async (typed: string, requestId?: unknown) => {
          let retried = false;
          // An `unknown` retry answer leaves the card up, as it would for a
          // user, who presses Retry again. A restarted Claude bridge answers
          // 500 for up to 30 s while it waits out the killed process's
          // preference lock (docs/todo 0059).
          let retryAgain = false;
          let retries = 0;
          let retiredSeen = false;
          await expect
            .poll(
              async () => {
                const current = await projection();
                // The bridge said the id is lost, and the backend settled it
                // without anyone pressing Retry.
                if (
                  !retiredSeen &&
                  !retried &&
                  requestId !== undefined &&
                  current?.retiredDispatch?.requestId === requestId
                ) {
                  retiredSeen = true;
                  expect(current.retiredDispatch.message).toMatch(
                    /could not confirm this message, so it may not have run/,
                  );
                  testInfo.annotations.push({
                    type: "retired-without-retry",
                    description: `${typed}: settled as lost by reconciliation, no Retry needed`,
                  });
                }
                const parked = current?.recoverableDispatch;
                if (
                  parked?.status === "action-required" &&
                  (!retried || (retryAgain && retries < 4))
                ) {
                  retried = true;
                  retries += 1;
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
                  retryAgain = outcome.outcome === "unknown";
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

        await test.step("a lost acknowledgement retires automatically after restart and preserves the draft", async () => {
          // Claude's durable claim has no recoverable outcome after restart.
          // Codex keeps a dispatched outcome, so it cannot exercise retirement.
          if (provider !== "claude") return;
          const typed = "/slashq-added lost-ack";
          await selectCommand("/slashq-added", "lost-ack");
          const submission = await sendRestartDraft(typed);
          await expect.poll(() => settled(), { timeout: 180_000 }).toBe(true);
          await expect.poll(() => executions("lost-ack"), { timeout: 90_000 }).toBe(1);
          await openEnvironment(other.name);
          // Hold the browser away from this session. Model the lost backend
          // acknowledgement at the persistence boundary, while retaining the
          // real bridge's durable claim and performing a real process restart.
          await restartBridge();
          expect(status.dataDir).toBeTruthy();
          const staged = spawnSync(
            "bun",
            [
              path.join(import.meta.dirname, "slash-command-lost-ack.ts"),
              status.dataDir!,
              target.id,
              provider,
              sessionKey,
              String(submission.requestId),
              typed,
            ],
            { cwd: repositoryRoot, encoding: "utf8" },
          );
          expect(staged.status, staged.stderr).toBe(0);
          const draftKey = `${provider}:${target.id}:${encodeURIComponent(sessionKey)}`;
          await invoke("save_compose_draft", {
            draftKey,
            ownerType: "environment",
            ownerId: target.id,
            value: {
              text: typed,
              mentions: [],
              attachments: [],
              annotations: [],
              metadata: { platform: provider, requestId: submission.requestId },
            },
          });
          const readSession = () =>
            invoke<{
              pendingDispatch?: { requestId: string };
              retiredDispatch?: { requestId: string };
              dispatchedRequestIds?: string[];
            }>("get_native_agent_session", identity);
          expect((await readSession()).pendingDispatch?.requestId).toBe(submission.requestId);
          await expect
            .poll(
              async () => {
                const current = await projection();
                if (current?.retiredDispatch?.requestId === submission.requestId) return "retired";
                const stored = await readSession();
                return JSON.stringify({
                  phase: current?.turn.phase,
                  hasError: Boolean(current?.turn.error),
                  pending: stored.pendingDispatch?.requestId === submission.requestId,
                  retired: stored.retiredDispatch?.requestId === submission.requestId,
                  acknowledged: stored.dispatchedRequestIds?.includes(String(submission.requestId)),
                });
              },
              { timeout: 90_000 },
            )
            .toBe("retired");
          const retired = (await projection())!;
          expect(retired.recoverableDispatch).toBeUndefined();
          expect(retired.retiredDispatch!.message).toMatch(/could not confirm this message/);
          await page.reload();
          await openEnvironment(target.name);
          await expect(input).toHaveText(typed, { timeout: 90_000 });
          const warning = page.getByText(retired.retiredDispatch!.message, { exact: true });
          await expect(warning).toBeVisible({ timeout: 30_000 });
          await expect(page.getByRole("button", { name: "Retry send" })).toHaveCount(0);
          await expect(
            page
              .locator("[data-sonner-toast]")
              .filter({ hasText: retired.retiredDispatch!.message }),
          ).toHaveCount(0);
          const readDraft = () =>
            invoke<{
              value: {
                text: string;
                metadata?: { requestId?: string; pendingTranscriptConfirmation?: unknown };
              };
            } | null>("get_compose_draft", { draftKey });
          await expect
            .poll(async () => (await readDraft())?.value.metadata?.requestId, {
              timeout: 30_000,
            })
            .toBeUndefined();
          const draft = await readDraft();
          expect(draft?.value.text).toBe(typed);
          expect(draft?.value.metadata?.pendingTranscriptConfirmation).toBeUndefined();
          const resent = await sendRestartDraft(typed);
          expect(resent.requestId).not.toBe(submission.requestId);
          await expect.poll(() => executions("lost-ack"), { timeout: 180_000 }).toBe(2);
          await expect.poll(() => settled(), { timeout: 180_000 }).toBe(true);
        });

        await test.step("a bridge restart right after Send never runs the command twice", async () => {
          await selectCommand("/slashq-added", "gamma");
          const submission = await sendRestartDraft("/slashq-added gamma");
          await restartBridge();
          await openEnvironment(other.name);
          const retried = await settleAfterRestart("/slashq-added gamma", submission.requestId);
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
          const retried = await settleAfterRestart("/slashq-long delta", submission.requestId);
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
