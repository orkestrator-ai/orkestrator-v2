/**
 * The native `/` picker against real providers in a `dev:test --fixture`
 * profile: source groups, keyboard order, a command file edited on disk
 * reaching the picker after a refresh, and the new row surviving a reload
 * (docs/todo/cli-and-slash-commands/0016-slash-command-catalogue.md,
 * "Qualification").
 *
 * Opt-in only (`ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1`): it opens provider
 * sessions on the host's credentials. `ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS`
 * picks from `claude`, `pi` and `grok` (default `claude`). The checks are
 * metadata only: no case sends a prompt, so no model turn is spent. A new Pi
 * tab lists its templates and skills before its session attaches, from a
 * resource-only read that runs no extension code, as a `stale` list marked
 * `attachPending` (extension commands arrive on attach); on Pi the case checks
 * that state first, with no refresh and no turn
 * (docs/todo/cli-and-slash-commands/0069-pi-commands-before-first-turn.md). Commands
 * are planted in a disposable host worktree created with the
 * execution-policy override `projectResources: true` (never this repository,
 * never a provider home), or, with `ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT=container`
 * on a profile started with `--fixture-environments local,container`, in a
 * containerized environment's own `/workspace` through `docker exec` (no
 * override: a container loads project resources by default).
 */
import { expect, test, type Locator } from "@playwright/test";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  authenticatedInvoke,
  containerWorkspace,
  hostWorkspace,
  profileStatus,
  sidebarNavigator,
  type Environment,
  type Project,
} from "./slash-command-live-support";

type Row = { name: string; insertText?: string; source?: string; executionKind?: string };
type Projection = {
  messages?: Array<{ role?: unknown }>;
  slashCommands?: Row[];
  slashCommandCatalogue?: {
    status: string;
    error?: unknown;
    lastRefresh?: unknown;
    attachPending?: boolean;
  };
} | null;

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_SLASH === "1";

/** Where each provider reads a project command file. */
const PROVIDERS = {
  claude: {
    commandFile: (name: string) => `.claude/commands/${name}.md`,
    partialBeforeTurn: false,
  },
  // Templates and skills before attach; extension commands only after it.
  pi: { commandFile: (name: string) => `.pi/prompts/${name}.md`, partialBeforeTurn: true },
  // Grok lists `.grok/commands/*.md` as skills once the folder is trusted,
  // which the bridge arranges when project resources are on.
  grok: { commandFile: (name: string) => `.grok/commands/${name}.md`, partialBeforeTurn: false },
} as const;
type Provider = keyof typeof PROVIDERS;

/** `SOURCE_LABELS` in `SlashCommandMenu.tsx`; a renamed label fails here. */
const SOURCE_LABELS: Record<string, string> = {
  orkestrator: "Orkestrator",
  builtin: "Built in",
  project: "Project",
  user: "User",
  plugin: "Plugins",
  skill: "Skills",
  template: "Templates",
  extension: "Extensions",
  unknown: "Other",
};

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
  const raw = process.env.ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS?.trim() || "claude";
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

const commandBody = (description: string) =>
  `---\ndescription: ${description}\n---\nReply with exactly the word ${description}.\n`;

/** The picker's visible label for a row: what it inserts. */
const display = (row: Row) => row.insertText ?? row.name;

/** `SLASH_COMMAND_SEARCH_LIMIT`: an empty query shows the first 100 rows. */
const PICKER_ROW_LIMIT = 100;

/** Consecutive runs of one source, the way the picker groups rows. */
function expectedGroups(rows: Row[]): Array<{ label: string; names: string[] }> {
  const groups: Array<{ source: string; names: string[] }> = [];
  for (const row of rows.slice(0, PICKER_ROW_LIMIT)) {
    const source = row.source ?? "unknown";
    const last = groups.at(-1);
    if (last?.source === source) last.names.push(display(row));
    else groups.push({ source, names: [display(row)] });
  }
  return groups.map(({ source, names }) => ({
    label: SOURCE_LABELS[source] ?? SOURCE_LABELS.unknown!,
    names,
  }));
}

/** Each rendered group's header and the leading text of its options. */
async function renderedGroups(picker: Locator) {
  return picker.getByRole("group").evaluateAll((groups) =>
    groups.map((group) => {
      const headerId = group.getAttribute("aria-labelledby");
      const header = headerId ? document.getElementById(headerId)?.textContent : null;
      return {
        label: header ?? group.getAttribute("aria-label") ?? "",
        names: Array.from(group.querySelectorAll('[role="option"]')).map(
          (option) => option.querySelector("span")?.textContent ?? "",
        ),
      };
    }),
  );
}

for (const provider of LIVE_OPT_IN ? selectedProviders() : (["claude"] as Provider[])) {
  const spec = PROVIDERS[provider];

  test.describe(`live slash-command picker in a ${ENVIRONMENT_KIND} environment (${provider})`, () => {
    test.skip(!LIVE_OPT_IN, "opt-in live provider sessions on the isolated fixture");

    test("groups by source, moves in list order, and shows an edited command after refresh and reload", async ({
      page,
    }, testInfo) => {
      const container = ENVIRONMENT_KIND === "container";
      // A container's first start clones the workspace and runs its setup.
      test.setTimeout(container ? 1_200_000 : 600_000);
      page.setDefaultTimeout(15_000);
      await page.setViewportSize({ width: 1440, height: 1600 });
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

      let environment: Environment | undefined;
      try {
        environment = await invoke<Environment>("create_environment", {
          projectId: fixture!.id,
          name: `picker-${provider}-${Date.now()}`,
          networkAccessMode: "restricted",
          ...(container
            ? { environmentType: "containerized" }
            : {
                environmentType: "local",
                agentSettings: { executionPolicy: { projectResources: true } },
              }),
        });
        await invoke("start_environment", { environmentId: environment.id });
        let started = await invoke<Environment>("get_environment", {
          environmentId: environment.id,
        });
        if (container) {
          // Start returns once setup is launched; the clone lands later.
          await expect
            .poll(
              async () => {
                started = await invoke<Environment>("get_environment", {
                  environmentId: environment!.id,
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
        const workspace = containerId
          ? containerWorkspace(containerId)
          : hostWorkspace(started.worktreePath!);
        const tag = `pq${Math.floor(100_000 + Math.random() * 900_000)}`;
        const first = `${tag}-alpha`;
        const second = `${tag}-beta`;
        const added = `${tag}-added`;
        workspace.write(spec.commandFile(first), commandBody(`${tag}alpha`));
        workspace.write(spec.commandFile(second), commandBody(`${tag}beta`));

        const tabId = `picker-${provider}-tab`;
        const identity = {
          environmentId: environment.id,
          agent: provider,
          logicalSessionKey: `env-${environment.id}:${tabId}`,
        };
        const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
          environmentId: environment.id,
        });
        await invoke("save_pane_layout", {
          environmentId: environment.id,
          expectedRevision: layout?.revision ?? 0,
          layout: {
            version: PANE_LAYOUT_VERSION,
            containerId,
            activePaneId: "pane-picker",
            root: {
              kind: "leaf",
              id: "pane-picker",
              activeTabId: tabId,
              tabs: [
                {
                  id: tabId,
                  type: "agent-native",
                  nativeAgentData: {
                    environmentId: environment.id,
                    ...(containerId ? { containerId } : {}),
                    platform: provider,
                    isLocal: !container,
                  },
                },
              ],
            },
          },
        });

        const projection = () => invoke<Projection>("get_native_agent_projection", identity);
        const rows = async () => (await projection())?.slashCommands ?? [];
        const listed = async (needle: string) =>
          (await rows()).some((row) => display(row).includes(needle));

        const openEnvironment = sidebarNavigator(page, fixture!.name);
        const composeBar = page.getByTestId("shared-native-compose-bar");
        const input = composeBar.getByRole("textbox").first();
        const picker = page.getByRole("listbox", { name: "Slash commands" });
        const typeIntoComposer = async (text: string) => {
          await expect(input).toBeVisible({ timeout: 90_000 });
          await expect(async () => {
            await input.click();
            await input.fill("");
            await page.keyboard.type(text);
            await expect(input).toHaveText(text, { timeout: 2_000 });
          }).toPass({ timeout: 30_000 });
        };

        await page.goto(status.browserUrl!);
        await openEnvironment(environment.name);

        if (spec.partialBeforeTurn) {
          await test.step("before it attaches the session lists its templates, marked attach-pending, without a refresh", async () => {
            await expect
              .poll(async () => (await listed(first)) && (await listed(second)), {
                timeout: 120_000,
                message: "the planted templates were not listed before the session attached",
              })
              .toBe(true)
              .catch(async (error: unknown) => {
                const current = await projection();
                throw new Error(
                  `${String(error)}\ncatalogue: ${JSON.stringify(current?.slashCommandCatalogue)}\n` +
                    `rows: ${JSON.stringify((current?.slashCommands ?? []).map(display))}`,
                );
              });
            expect((await projection())?.slashCommandCatalogue).toMatchObject({
              status: "stale",
              attachPending: true,
            });
            // Nothing was sent: the list came from a read, not a turn.
            expect((await projection())?.messages ?? []).toEqual([]);
            await typeIntoComposer("/");
            await expect(picker).toBeVisible({ timeout: 30_000 });
            await expect(
              page.getByText(
                /More commands load when the session starts; refresh to load them now\./,
              ),
            ).toBeVisible({ timeout: 30_000 });
            await input.press("Escape");
            await input.fill("");
          });
        }
        await expect
          .poll(async () => (await listed(first)) && (await listed(second)), {
            timeout: 180_000,
            message: "the planted project commands never reached the catalogue",
          })
          .toBe(true)
          .catch(async (error: unknown) => {
            // Say what the catalogue held instead: its state and row names.
            const current = await projection();
            throw new Error(
              `${String(error)}\ncatalogue: ${JSON.stringify(current?.slashCommandCatalogue)}\n` +
                `rows: ${JSON.stringify((current?.slashCommands ?? []).map(display))}`,
            );
          });

        await test.step("source groups: one header per run of a source, in catalogue order", async () => {
          await typeIntoComposer("/");
          await expect(picker).toBeVisible({ timeout: 30_000 });
          const catalogue = await rows();
          const expected = expectedGroups(catalogue);
          await expect.poll(() => renderedGroups(picker), { timeout: 30_000 }).toEqual(expected);
          // Every planted command sits under the group its source names.
          const planted = expected.find((group) =>
            group.names.some((name) => name.includes(first)),
          );
          expect(planted?.names.some((name) => name.includes(second))).toBe(true);
          testInfo.annotations.push({
            type: "groups",
            description: expected
              .map((group) => `${group.label} (${group.names.length})`)
              .join(", "),
          });
        });

        await test.step("keyboard order: arrows follow the rendered order across groups and clamp", async () => {
          const options = picker.getByRole("option");
          const order = await options.evaluateAll((nodes) =>
            nodes.map((node) => node.querySelector("span")?.textContent ?? ""),
          );
          const selected = () =>
            picker
              .locator('[role="option"][aria-selected="true"]')
              .evaluate((node) => node.querySelector("span")?.textContent ?? "");
          expect(await selected()).toBe(order[0]);
          // Up from the top stays at the top (navigation clamps).
          await input.press("ArrowUp");
          expect(await selected()).toBe(order[0]);
          for (let index = 1; index < order.length; index += 1) {
            await input.press("ArrowDown");
            expect(await selected()).toBe(order[index]);
          }
          await input.press("ArrowDown");
          expect(await selected()).toBe(order.at(-1));
          await input.press("ArrowUp");
          expect(await selected()).toBe(order.at(-2) ?? order[0]);
          await input.press("Escape");
          await input.fill("");
        });

        await test.step("a command file added on disk appears after a refresh", async () => {
          workspace.write(spec.commandFile(added), commandBody(`${tag}added`));
          const refresh = await invoke<{ outcome: string }>(
            "refresh_native_agent_commands",
            identity,
          );
          testInfo.annotations.push({ type: "refresh-outcome", description: refresh.outcome });
          await expect
            .poll(() => listed(added), {
              timeout: 60_000,
              message: `the added command never appeared (refresh answered ${refresh.outcome})`,
            })
            .toBe(true);
          await typeIntoComposer(`/${tag}`);
          await expect(picker.getByRole("option", { name: new RegExp(added) })).toBeVisible({
            timeout: 30_000,
          });
          await input.press("Escape");
          await input.fill("");
        });

        await test.step("the new row survives a hard reload", async () => {
          await page.reload();
          await openEnvironment(environment!.name);
          await typeIntoComposer(`/${tag}`);
          await expect(picker.getByRole("option", { name: new RegExp(added) })).toBeVisible({
            timeout: 30_000,
          });
          for (const name of [first, second]) {
            await expect(picker.getByRole("option", { name: new RegExp(name) })).toBeVisible();
          }
          await input.press("Escape");
          await input.fill("");
        });
      } finally {
        if (environment) {
          await invoke("stop_environment", { environmentId: environment.id }).catch(
            () => undefined,
          );
          await invoke("delete_environment", { environmentId: environment.id }).catch(
            () => undefined,
          );
        }
      }
    });
  });
}
