import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { StoreApi } from "zustand/vanilla";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { type ClaudeOptionsState, claudeOptionsStore } from "./claudeOptionsStore";
import { appCommandStore } from "@/test/app-command-store";

const NODE_A = "bk_claude-options-a" as BackendId;
const NODE_B = "bk_claude-options-b" as BackendId;

let windowScope: WindowScope;
/** NODE_A's instance; the tests name their scope, as converted code does. */
let store: StoreApi<ClaudeOptionsState>;

beforeEach(() => {
  windowScope = new WindowScope();
  store = windowScope
    .open({ role: "command", client: new FakeNodeClient({ nodeId: NODE_A }) })
    .store(claudeOptionsStore);
});

afterEach(() => {
  windowScope.dispose();
  resetWindowScopeForTests();
});

describe("claudeOptionsStore", () => {
  test("stores and clears launch options per environment", () => {
    store.getState().setOptions("env-1", {
      launchAgent: true,
      agentType: "codex",
      initialPrompt: "Fix tests",
    });

    expect(store.getState().getOptions("env-1")).toEqual({
      launchAgent: true,
      agentType: "codex",
      initialPrompt: "Fix tests",
    });
    expect(store.getState().getOptions("env-2")).toBeUndefined();

    store.getState().clearOptions("env-1");

    expect(store.getState().getOptions("env-1")).toBeUndefined();
  });

  test("round-trips one-shot model and reasoning effort", () => {
    const actions = store.getState();
    actions.setOptions("env-1", {
      launchAgent: true,
      agentType: "codex",
      initialPrompt: "Fix tests",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(store.getState().getOptions("env-1")).toEqual(
      expect.objectContaining({ model: "gpt-5.6-sol", reasoningEffort: "high" }),
    );

    actions.clearOptions("env-1");
    expect(store.getState().getOptions("env-1")).toBeUndefined();
  });

  test("stores initial prompt attachments with launch options", () => {
    store.getState().setOptions("env-1", {
      launchAgent: true,
      agentType: "claude",
      initialPrompt: "Use this image",
      initialPromptAttachments: [
        {
          id: "img-1",
          name: "screenshot.png",
          previewUrl: "data:image/png;base64,QUJD",
          base64Data: "QUJD",
        },
      ],
    });

    expect(store.getState().getOptions("env-1")).toEqual({
      launchAgent: true,
      agentType: "claude",
      initialPrompt: "Use this image",
      initialPromptAttachments: [
        {
          id: "img-1",
          name: "screenshot.png",
          previewUrl: "data:image/png;base64,QUJD",
          base64Data: "QUJD",
        },
      ],
    });
  });

  test("each node scope holds its own options", () => {
    const other = windowScope
      .open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) })
      .store(claudeOptionsStore);
    store.getState().setOptions("env-1", {
      launchAgent: true,
      agentType: "claude",
      initialPrompt: "On node A",
    });
    expect(other.getState().getOptions("env-1")).toBeUndefined();
    windowScope.get(NODE_A)?.dispose();
    expect(windowScope.get(NODE_A)).toBeNull();
    expect(other.getState().options).toEqual({});
  });

  test("the deprecated statics reach the app's command scope", () => {
    resetWindowScopeForTests(new FakeNodeClient({ nodeId: NODE_A }));
    appCommandStore(claudeOptionsStore).getState().setOptions("env-1", {
      launchAgent: false,
      agentType: "codex",
      initialPrompt: "",
    });
    expect(
      getWindowScope().commandScope().store(claudeOptionsStore).getState().getOptions("env-1"),
    ).toMatchObject({ agentType: "codex" });
    expect(store.getState().getOptions("env-1")).toBeUndefined();
  });
});
