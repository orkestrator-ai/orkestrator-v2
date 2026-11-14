/**
 * Ask agent and Resume across the desktop renderer pairing (to-do 8011 (retired)),
 * after the canvas journey in design-canvas-renderer-pairing-electron.spec.ts.
 * The paired backend runs a real Claude Code on a loopback Anthropic endpoint
 * (`fake-anthropic-model.ts`, wired by `design-renderer-pairing-support.ts`),
 * so a real conversation runs with no login and nothing billed.
 *
 * {@link runAskAgentJourney}, in whichever renderer the window runs:
 *
 * 1. A blank canvas, its frame selected, **Ask agent about the selection**,
 *    **Start a new conversation** (Claude, the default in both releases): a
 *    "Design chat" tab opens with the design context in its unsent draft and
 *    the canvas records the link.
 * 2. **Send message**: exactly one model turn carries the context (the canvas
 *    id from the draft's reference), and its answer shows in the transcript.
 * 3. Ask agent again lists the link as open; then the conversation's tab is
 *    closed and Ask agent lists it as closed. What "closed" offers depends on
 *    the pair:
 *    - this renderer on a backend that has `design_session_link_states`:
 *      **Resume** (the backend recorded the session on the link);
 *    - this renderer on an older backend: the command is unknown there, the
 *      renderer maps that to the `unsupported` fallback and the row reads
 *      "Closed — conversation ended", with no Resume;
 *    - an older renderer (v2.22.3 predates Resume): "Closed — conversation
 *      ended" from its own pane layout, whatever the backend.
 *
 * {@link resumeLinkedConversation} presses **Resume** in this renderer: the
 * conversation reopens in a new `design-resume-…` tab with its transcript,
 * the link moves there, and no model call is made.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./electron-fixtures";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import type {
  DesignSessionLink,
  DesignSessionLinkStates,
  DesignSnapshotEnvelope,
} from "@orkestrator/protocol/design-operations";

import type { RuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import {
  openFixtureEnvironment,
  pageInvoke,
  selectEnvironment,
  type Invoke,
} from "./design-canvas-electron-journey";
import type { FakeAnthropicModel, FakeModelCall } from "./fake-anthropic-model";

const AGENT_DESIGN_NAME = "Agent design";
const CHAT_TITLE = "Design chat";
const CLOSED_ENDED = "Closed — conversation ended";
const CLOSED_RESUMABLE = "Closed — can be resumed";
/** How long a settled conversation is watched for a model call it must not make. */
const QUIET_MS = 5_000;

type CommandResult<T> = { ok: true; value: T } | { ok: false; failure: { message: string } };

/** What a later client needs to find the conversation {@link runAskAgentJourney} made. */
export interface AskAgentResult {
  projectName: string;
  environmentId: string;
  environmentName: string;
  canvasId: string;
  link: DesignSessionLink;
  /** Model calls of the conversation's turns when the tab closed. */
  turnCalls: number;
}

/**
 * The model calls of a conversation's turns about `canvasId`: the CLI offers
 * its tools on a turn call, and the draft's reference carries the canvas id.
 */
function turnCallsAbout(model: FakeAnthropicModel, canvasId: string): FakeModelCall[] {
  return model.calls().filter((call) => call.tools.length > 0 && call.prompt.includes(canvasId));
}

async function snapshotOf(invoke: Invoke, environmentId: string, canvasId: string) {
  const result = await invoke<CommandResult<DesignSnapshotEnvelope>>("design_snapshot", {
    environmentId,
    canvasId,
  });
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
}

type TabTag = "design" | "chat";

/**
 * Tag the pane tab whose close control is labelled `Close <title>…` so later
 * steps find it after its title changes (both renderers number a tab after
 * its label, "Design chat 3", and retitle a conversation once it has a first
 * message). Both releases put the close button directly inside the tab
 * element, and that element stays mounted across a retitle; v2.22.3's tab has
 * no `tab` role, so roles cannot find it. Returns false while no such tab is
 * rendered.
 */
async function tagTab(window: Page, title: string, tag: TabTag): Promise<boolean> {
  return window.evaluate(
    ({ title, tag }) => {
      const close = Array.from(document.querySelectorAll("button[aria-label]")).filter((button) =>
        new RegExp(`^Close ${title}( \\d+)?$`).test(button.getAttribute("aria-label") ?? ""),
      );
      const tab = close.at(-1)?.parentElement;
      if (!tab) return false;
      for (const other of Array.from(document.querySelectorAll(`[data-pairing-tab="${tag}"]`)))
        other.removeAttribute("data-pairing-tab");
      tab.setAttribute("data-pairing-tab", tag);
      return true;
    },
    { title, tag },
  );
}

function taggedTab(window: Page, tag: TabTag) {
  return window.locator(`[data-pairing-tab="${tag}"]`);
}

async function closeTaggedTab(window: Page, tag: TabTag) {
  const tab = taggedTab(window, tag);
  // The close button sits inside the tab and shows on hover.
  await tab.hover();
  await tab.locator(':scope > button[aria-label^="Close "]').click({ force: true });
  await expect(tab).toHaveCount(0, { timeout: 30_000 });
}

async function openAskAgent(window: Page) {
  await window.getByRole("button", { name: "Ask agent about the selection" }).click();
  const dialog = window.getByRole("dialog", { name: "Ask agent about this design" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Ask agent in a new Claude conversation, send it, close its tab and read the
 * closed link's row. `resumeOffered` says whether this renderer, on this
 * backend, must offer Resume once the tab is closed (see the module comment).
 */
export async function runAskAgentJourney({
  window,
  profile,
  model,
  backendHasLinkStates,
  resumeOffered,
  olderRenderer = false,
}: {
  window: Page;
  profile: RuntimeProfile;
  model: FakeAnthropicModel;
  /** The paired backend answers `design_session_link_states` (added 2026-10-24). */
  backendHasLinkStates: boolean;
  resumeOffered: boolean;
  /** v2.22.3's renderer, as in the canvas journey's option of that name. */
  olderRenderer?: boolean;
}): Promise<AskAgentResult> {
  const { invoke, project, environment } = await openFixtureEnvironment(
    window,
    profile,
    "design-agent",
  );
  let canvasId = "";
  let frameId = "";
  let link: DesignSessionLink | undefined;

  await test.step("ask agent: a new Claude conversation gets the selection's context", async () => {
    await window.getByRole("button", { name: "New design workspace" }).click();
    const workspace = window.getByRole("dialog", { name: "Design workspace" });
    await expect(workspace).toBeVisible();
    await workspace.getByRole("textbox", { name: "Name", exact: true }).fill(AGENT_DESIGN_NAME);
    await workspace.getByRole("combobox", { name: "Design agent", exact: true }).click();
    await window.getByRole("option", { name: "Blank canvas (no agent)", exact: true }).click();
    await workspace.getByRole("combobox", { name: "Initial frame", exact: true }).click();
    await window.getByRole("option", { name: "Mobile 390×844", exact: true }).click();
    await workspace.getByRole("button", { name: "Create blank canvas", exact: true }).click();
    await expect(workspace).toHaveCount(0, { timeout: 30_000 });
    const title = window.getByRole("button", { name: "Move frame Mobile", exact: true });
    await expect(title).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => tagTab(window, "Design", "design")).toBe(true);
    const entries = (
      await invoke<{ value: { entries: Array<{ id: string }> } }>("design_library", {
        environmentId: environment.id,
        query: { search: AGENT_DESIGN_NAME },
      })
    ).value.entries;
    expect(entries).toHaveLength(1);
    canvasId = entries[0]!.id;
    const canvas = await invoke<DesignCanvas>("design_action", {
      environmentId: environment.id,
      action: "get_canvas",
      input: { canvasId },
    });
    expect(canvas.frames).toHaveLength(1);
    frameId = canvas.frames[0]!.id;

    // The selection is the frame: its id goes into the context.
    await title.click();
    await expect(title).toHaveAttribute("aria-pressed", "true");
    const dialog = await openAskAgent(window);
    await expect(dialog.getByText("No conversations are linked to this design yet.")).toBeVisible();
    await dialog.getByRole("button", { name: "Start a new conversation", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => tagTab(window, CHAT_TITLE, "chat"), { timeout: 30_000 }).toBe(true);

    await expect
      .poll(async () => (await snapshotOf(invoke, environment.id, canvasId)).workspace.sessions, {
        timeout: 30_000,
      })
      .toHaveLength(1);
    link = (await snapshotOf(invoke, environment.id, canvasId)).workspace.sessions[0]!;
    expect(link).toMatchObject({ platform: "claude", role: "design", label: CHAT_TITLE });
    // Nothing is sent from the dialog: the context waits in the draft.
    expect(turnCallsAbout(model, canvasId)).toHaveLength(0);
  });

  await test.step("send: one turn carries the context and its answer shows", async () => {
    // A tab whose session has not started sends its first message with
    // "Start agent"; the draft holds the design context (this renderer shows
    // it as a removable chip, v2.22.3 shows nothing for it).
    if (!olderRenderer)
      await expect(window.getByText("Design context", { exact: true })).toBeVisible();
    const send = window.getByRole("button", { name: /^(Start agent|Send message)$/ });
    await expect(send).toBeEnabled({ timeout: 90_000 });
    await send.click();
    await expect.poll(() => turnCallsAbout(model, canvasId).length, { timeout: 120_000 }).toBe(1);
    const [turn] = turnCallsAbout(model, canvasId);
    expect(turn!.prompt).toContain("Design context");
    // The selection: the frame selected when Ask agent opened.
    expect(turn!.prompt).toContain(frameId);
    await expect(window.getByText(/Answer to:/).first()).toBeVisible({ timeout: 60_000 });
    // Exactly once: no repeat arrives once the turn has settled.
    await window.waitForTimeout(QUIET_MS);
    expect(turnCallsAbout(model, canvasId)).toHaveLength(1);
  });

  const turnCalls = turnCallsAbout(model, canvasId).length;

  await test.step("the canvas lists the link: open, then closed with its tab", async () => {
    await taggedTab(window, "design").click();
    let dialog = await openAskAgent(window);
    await expect(
      dialog.getByRole("radio", { name: new RegExp(`^Send to ${CHAT_TITLE}\\b`) }),
    ).toBeChecked();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await closeTaggedTab(window, "chat");

    const linkStates = () =>
      invoke<CommandResult<DesignSessionLinkStates> | DesignSessionLinkStates>(
        "design_session_link_states",
        { environmentId: environment.id, canvasId },
      ).then((result) =>
        "ok" in result ? (result.ok ? result.value : Promise.reject(result.failure)) : result,
      );
    if (backendHasLinkStates) {
      // Tab teardown records the conversation's session on the link.
      await expect
        .poll(
          async () => {
            const states = await linkStates();
            const recorded = states.sessions.find((candidate) => candidate.id === link!.id);
            const state = states.states.find((candidate) => candidate.linkId === link!.id);
            return { session: state?.session, recorded: Boolean(recorded?.sessionId) };
          },
          { timeout: 60_000 },
        )
        .toEqual({ session: "missing", recorded: true });
      link = (await linkStates()).sessions.find((candidate) => candidate.id === link!.id)!;
    } else {
      // An older backend does not know the command: the renderer's fallback.
      const refusal = await linkStates().then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : JSON.stringify(error)),
      );
      expect(refusal, "an older backend must refuse design_session_link_states").toMatch(
        /unknown|unsupported/i,
      );
    }

    await taggedTab(window, "design").click();
    dialog = await openAskAgent(window);
    const links = dialog.getByRole("region", { name: "Linked conversations" });
    const resume = links.getByRole("button", { name: `Resume ${CHAT_TITLE}`, exact: true });
    if (resumeOffered) {
      await expect(links.getByText(CLOSED_RESUMABLE, { exact: false })).toBeVisible({
        timeout: 30_000,
      });
      await expect(resume).toBeVisible();
    } else {
      await expect(links.getByText(CLOSED_ENDED, { exact: false })).toBeVisible({
        timeout: 30_000,
      });
      await expect(resume).toHaveCount(0);
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // Closing and reading the link made no model call.
    expect(turnCallsAbout(model, canvasId)).toHaveLength(turnCalls);
  });

  return {
    projectName: project.name,
    environmentId: environment.id,
    environmentName: environment.name,
    canvasId,
    link: link!,
    turnCalls,
  };
}

/**
 * Press Resume on the conversation {@link runAskAgentJourney} closed, in this
 * renderer: it reopens in a new `design-resume-…` tab with its transcript, the
 * link moves to that tab, and nothing is sent.
 */
export async function resumeLinkedConversation({
  window,
  model,
  asked,
}: {
  window: Page;
  model: FakeAnthropicModel;
  asked: AskAgentResult;
}): Promise<void> {
  const invoke = pageInvoke(window);
  await test.step("resume: the closed conversation reopens with its transcript", async () => {
    await selectEnvironment(window, asked.projectName, asked.environmentName);
    await expect.poll(() => tagTab(window, "Design", "design"), { timeout: 30_000 }).toBe(true);
    await taggedTab(window, "design").click();
    await expect(
      window.getByRole("button", { name: "Move frame Mobile", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const dialog = await openAskAgent(window);
    const links = dialog.getByRole("region", { name: "Linked conversations" });
    await expect(links.getByText(CLOSED_RESUMABLE, { exact: false })).toBeVisible({
      timeout: 30_000,
    });
    await links.getByRole("button", { name: `Resume ${CHAT_TITLE}`, exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });

    await expect
      .poll(
        async () => {
          const canvas = (await snapshotOf(invoke, asked.environmentId, asked.canvasId)).workspace
            .sessions;
          return canvas.find((candidate) => candidate.id === asked.link.id)?.tabId ?? "";
        },
        { timeout: 60_000 },
      )
      .toMatch(/^design-resume-/);
    await expect(window.getByText(/Answer to:/).first()).toBeVisible({ timeout: 90_000 });
    // The shared layout holds exactly one resume tab.
    const layout = await invoke<{ root?: unknown } | null>("get_pane_layout", {
      environmentId: asked.environmentId,
    });
    expect(JSON.stringify(layout).match(/"design-resume-[^"]*"/g)?.length ?? 0).toBeGreaterThan(0);
    expect(new Set(JSON.stringify(layout).match(/design-resume-[a-z0-9-]+/g) ?? []).size).toBe(1);
    // Resume sends nothing: no model call after it settles.
    await window.waitForTimeout(QUIET_MS);
    expect(turnCallsAbout(model, asked.canvasId)).toHaveLength(asked.turnCalls);
  });
}

/** Stop and delete the journey's environment. */
export async function removeAskAgentEnvironment(window: Page, environmentId: string) {
  const invoke = pageInvoke(window);
  await invoke("stop_environment", { environmentId }).catch(() => undefined);
  await invoke("delete_environment", { environmentId }).catch(() => undefined);
}
