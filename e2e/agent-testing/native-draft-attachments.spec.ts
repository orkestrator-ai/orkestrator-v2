/**
 * INC-06 in the real stack: a saved Cursor or Grok image draft survives a
 * fresh renderer load and the autosave that follows it.
 *
 * The draft is seeded through the backend exactly as a composer saves it, so
 * the check needs no model turn and no provider credential. What it proves is
 * the renderer path the bug lived in — hydration, eligibility and re-save —
 * against the real backend store, across two hard reloads and an inactive
 * environment switch, then keyboard removal of the restored chip in a narrow
 * viewport.
 *
 * What "re-saved" means here. Once hydration settles, the persistence hook
 * schedules a save whether or not the restored value changed, and the backend
 * advances a draft's revision on every save. So after each load the stored
 * revision must rise strictly above the value read just before that load *and*
 * still hold the image — a hydration that filtered the image out would publish
 * an empty list, and one that never ran would leave the revision where it was.
 *
 * An assigned tab mounts its composer only once its provider bridge connects.
 * If the bridge cannot connect in this profile, the case verifies the stored
 * draft is intact and is then reported as skipped with that reason; it never
 * passes on a UI path it could not observe.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

type Status = { status: string; profile?: string; browserUrl?: string; testProject?: string };
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type DraftValue = {
  text?: string;
  attachments?: Array<Record<string, unknown>>;
  annotations?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
};
type Draft = { revision: number; value: DraftValue };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
// Same default as `playwright.browser.config.ts`, so artifacts and the stack
// under test always name the same profile. Which one was used is recorded on
// every case, and a profile that is not running fails with that name.
const profileFromEnvironment = process.env.ORKESTRATOR_AGENT_TEST_PROFILE;
const profile = profileFromEnvironment ?? "codex-qa";

// 1x1 transparent PNG: a harmless, valid image asset.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const IMAGE_NAME = "draft-image.png";
const NARROW_VIEWPORT = { width: 390, height: 844 };

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

async function signIn(page: Page, status: Status) {
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
    expect(invokeResponse.ok(), `${command} failed`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

const CASES = [
  { platform: "cursor", assigned: true, text: "keep this image" },
  { platform: "grok", assigned: true, text: "keep this image" },
  // The pre-session picker: an unassigned tab whose saved draft names the platform.
  { platform: "cursor", assigned: false, text: "keep this image" },
  { platform: "grok", assigned: false, text: "keep this image" },
  // Attachment-only drafts must not be treated as empty and deleted.
  { platform: "cursor", assigned: false, text: "" },
  { platform: "grok", assigned: true, text: "" },
] as const;

for (const { platform, assigned, text } of CASES) {
  const label = `${
    assigned ? `assigned ${platform} tab` : `pre-session picker with ${platform} selected`
  }${text ? "" : ", attachment only"}`;
  test(`a saved image draft survives reload and the autosave after it (${label})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    testInfo.annotations.push({
      type: "profile",
      description: profileFromEnvironment
        ? `${profile} (ORKESTRATOR_AGENT_TEST_PROFILE)`
        : `${profile} (default; set ORKESTRATOR_AGENT_TEST_PROFILE to use another)`,
    });
    const status = profileStatus();
    expect(status.profile, "dev:status answered for a different profile").toBe(profile);
    expect(
      status.status,
      `profile "${profile}" is not running; start it with mise run dev:test or set ORKESTRATOR_AGENT_TEST_PROFILE`,
    ).toBe("ready");
    expect(status.browserUrl, `profile "${profile}" has no browser URL`).toBeTruthy();
    expect(status.testProject, `profile "${profile}" has no seeded test project`).toBeTruthy();
    // Startup diagnostics only (bounded, content-free): if the renderer fails
    // to start, the reason is in these lines rather than lost with the page.
    page.on("console", (message) => {
      if (/DesktopStartup/.test(message.text())) {
        testInfo.annotations.push({ type: "startup", description: message.text().slice(0, 200) });
      }
    });
    const invoke = await signIn(page, status);
    const projects = await invoke<Project[]>("get_projects");
    const fixture = projects.find((project) => project.localPath === status.testProject);
    expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();
    const suffix = Date.now();
    const environment = await invoke<Environment>("create_environment", {
      projectId: fixture!.id,
      name: `draft-${platform}-${suffix}`,
      networkAccessMode: "restricted",
      environmentType: "local",
    });
    const other = await invoke<Environment>("create_environment", {
      projectId: fixture!.id,
      name: `draft-other-${platform}-${suffix}`,
      networkAccessMode: "restricted",
      environmentType: "local",
    });
    const tabId = `draft-${platform}-tab`;
    const sessionKey = `env-${environment.id}:${tabId}`;
    const namespace = assigned ? platform : "agent-native";
    const draftKey = `${namespace}:${environment.id}:${encodeURIComponent(sessionKey)}`;
    try {
      await invoke("start_environment", { environmentId: environment.id });
      const hydrated = await invoke<Environment>("get_environment", {
        environmentId: environment.id,
      });
      expect(hydrated.worktreePath).toBeTruthy();
      const worktree = hydrated.worktreePath!;
      mkdirSync(path.join(worktree, ".qa"), { recursive: true });
      const imagePath = path.join(worktree, ".qa", IMAGE_NAME);
      writeFileSync(imagePath, PNG);
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-draft",
          root: {
            kind: "leaf",
            id: "pane-draft",
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                nativeAgentData: assigned
                  ? { environmentId: environment.id, platform }
                  : { environmentId: environment.id },
              },
            ],
            activeTabId: tabId,
          },
        },
      });
      const attachment = {
        id: `attachment-${suffix}`,
        type: "image",
        name: IMAGE_NAME,
        path: imagePath,
      };
      // A plain transcript excerpt: restored as-is, with no browser-note migration.
      const annotation = {
        id: `annotation-${suffix}`,
        text: "quoted transcript line",
        comment: "why this matters",
        source: "transcript",
      };
      const seeded = await invoke<Draft>("save_compose_draft", {
        draftKey,
        ownerType: "environment",
        ownerId: environment.id,
        value: {
          text,
          mentions: [],
          attachments: [attachment],
          annotations: [annotation],
          ...(assigned ? {} : { metadata: { platform } }),
        },
      });

      const readStored = () => invoke<Draft | null>("get_compose_draft", { draftKey });
      const expectDraftContent = (stored: Draft | null) => {
        expect(stored, "the stored draft was deleted").toBeTruthy();
        expect(stored!.value.text).toBe(text);
        expect(stored!.value.attachments).toEqual([expect.objectContaining(attachment)]);
        expect(stored!.value.annotations).toEqual([expect.objectContaining(annotation)]);
        if (!assigned) expect(stored!.value.metadata).toMatchObject({ platform });
      };
      /**
       * The stored revision once no write is still in flight. An unmount flush
       * or a re-armed debounce from the previous page must land before a load
       * is measured, or its write could be mistaken for the new page's re-save.
       */
      const settledRevision = async (): Promise<number> => {
        let previous = (await readStored())?.revision ?? 0;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          // Longer than the composer's 400 ms save debounce.
          await page.waitForTimeout(1_000);
          const current = (await readStored())?.revision ?? 0;
          if (current === previous) return current;
          previous = current;
        }
        throw new Error("the stored draft never stopped changing");
      };
      /** The draft was re-published after `before` and still holds the image. */
      const expectRepublishedSince = async (before: number) => {
        await expect
          .poll(async () => (await readStored())?.revision ?? 0, {
            message: "hydration never re-saved the draft",
            timeout: 15_000,
          })
          .toBeGreaterThan(before);
        expectDraftContent(await readStored());
      };

      const openEnvironment = async (name: string) => {
        const expand = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
        const entry = page.getByText(name, { exact: true }).first();
        // Either the project is collapsed (expand it) or the entry is listed.
        await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
        if (await expand.isVisible()) await expand.click();
        // A sidebar tooltip from the previous hover can sit over the entry.
        await page.mouse.move(0, 0);
        await page.keyboard.press("Escape");
        await entry.click();
      };
      const composeBar: Locator = page.getByTestId(
        assigned ? "shared-native-compose-bar" : "unassigned-native-compose-bar",
      );
      const chip = composeBar.getByRole("button", { name: `Remove ${IMAGE_NAME}` });
      const connecting = page.getByText(/^Connecting to /);

      /** The composer shows the restored draft and re-saved it after `before`. */
      const expectRestored = async (before: number) => {
        await expect(chip.or(connecting)).toBeVisible({ timeout: 30_000 });
        const mounted = await chip
          .waitFor({ state: "visible", timeout: 45_000 })
          .then(() => true)
          .catch(() => false);
        if (!mounted && assigned && (await connecting.isVisible())) {
          // Nothing hydrated, so the only thing left to prove is that the
          // stored draft is untouched. The UI path is not claimed as passing.
          expectDraftContent(await readStored());
          testInfo.skip(
            true,
            `${platform} bridge did not connect in profile "${profile}": stored draft verified intact, UI restoration not observed`,
          );
        }
        await expect(chip).toBeVisible();
        await expect(composeBar.getByRole("textbox")).toHaveText(text);
        if (assigned) {
          await expect(composeBar.getByTestId("compose-annotation-count")).toHaveText(
            /1 annotation/,
          );
        } else {
          // An attachment-only draft is still sendable from the picker.
          await expect(composeBar.getByTitle("Start agent")).toBeEnabled();
        }
        await expectRepublishedSince(before);
      };

      /**
       * Load the app, retrying once only for the dev server's transient
       * "Failed to fetch dynamically imported module" on the renderer entry
       * (flake 0167). Production serves a bundle, so this cannot hide a user
       * failure; any other startup failure still fails the case. Each retry is
       * recorded as an annotation.
       */
      const loadApp = async (load: () => Promise<unknown>) => {
        await load();
        const failed = page.getByText("Orkestrator couldn’t connect");
        const expandOrList = page
          .getByRole("button", { name: `Expand project ${fixture!.name}` })
          .or(page.getByText(environment.name, { exact: true }).first());
        await expect(failed.or(expandOrList).first()).toBeVisible({ timeout: 30_000 });
        if (!(await failed.isVisible())) return;
        const devModuleFetch = testInfo.annotations.some(
          (annotation) =>
            annotation.type === "startup" &&
            (annotation.description ?? "").includes("Failed to fetch dynamically imported module"),
        );
        expect(devModuleFetch, "renderer failed to start for a reason other than 0167").toBe(true);
        testInfo.annotations.push({ type: "retry", description: "flake 0167: reloaded once" });
        await page.reload();
      };

      await loadApp(() => page.goto(status.browserUrl!));
      await openEnvironment(environment.name);
      await expectRestored(seeded.revision);
      // Leave so the composer can unmount, then come back.
      await openEnvironment(other.name);
      let before = await settledRevision();
      expectDraftContent(await readStored());
      await openEnvironment(environment.name);
      await expectRestored(before);

      for (let reload = 0; reload < 2; reload += 1) {
        before = await settledRevision();
        await loadApp(() => page.reload());
        await openEnvironment(environment.name);
        await expectRestored(before);
      }

      // Narrow viewport: the chip stays fully on screen and removable by keyboard.
      await page.setViewportSize(NARROW_VIEWPORT);
      // The mobile shell opens the projects drawer over the workspace; close it
      // the way a user would before reaching the composer.
      const closeDrawer = page
        .getByRole("button", { name: "Close projects and environments" })
        .first();
      // The drawer animates in after the resize, so wait for one of the two
      // outcomes before deciding whether it needs closing.
      await expect(closeDrawer.or(chip).first()).toBeVisible({ timeout: 15_000 });
      if (await closeDrawer.isVisible()) {
        await closeDrawer.click();
        await expect(closeDrawer).toBeHidden({ timeout: 15_000 });
      }
      await expect(chip).toBeVisible();
      await expect(chip).toBeInViewport({ ratio: 1 });
      before = await settledRevision();
      await chip.focus();
      await expect(chip).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(chip).toHaveCount(0);
      // The removal is published; text, annotations and metadata remain, so
      // the draft is saved without the image rather than deleted.
      await expect
        .poll(
          async () => {
            const stored = await readStored();
            return stored && stored.revision > before ? stored.value.attachments : undefined;
          },
          { message: "the keyboard removal was not saved", timeout: 15_000 },
        )
        .toEqual([]);
      const afterRemoval = await readStored();
      expect(afterRemoval!.value.text).toBe(text);
      expect(afterRemoval!.value.annotations).toEqual([expect.objectContaining(annotation)]);
    } finally {
      await invoke("delete_compose_draft", { draftKey }).catch(() => undefined);
      for (const created of [environment, other]) {
        await invoke("stop_environment", { environmentId: created.id }).catch(() => undefined);
        await invoke("delete_environment", { environmentId: created.id }).catch(() => undefined);
      }
    }
  });
}
