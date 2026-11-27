import { expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  stripSystemInstructions,
  SYSTEM_INSTRUCTIONS_FRAME_OPEN,
} from "@orkestrator/protocol/review-evidence-frames";
import type { ensureNativeAgentSession } from "@/lib/backend";
import { parsePromptTranscriptReferences } from "@/lib/chat/transcript-annotations";
import { composeDraftKey, persistComposeDraft } from "@/lib/compose-draft-persistence";
import { createSessionKey } from "@/lib/utils";
import { configStore } from "@/stores/configStore";
import { nativeComposeStore } from "@/stores/nativeComposeStore";
import { appCommandStore } from "@/test/app-command-store";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { buildDesignAgentContextAnnotation } from "../design/design-launch";
import {
  AgentNativeTab,
  defaultProjection,
  dispatchNativeAgentIntentMock,
  ensureNativeAgentSessionMock,
  installAgentNativeTabFixture,
  seedUnassignedDefaultCatalog,
  sessionProjectionMock,
} from "./AgentNativeTab.test-support";

await installAgentNativeTabFixture();

const environmentId = "env-1";
const tabId = "design-agent-123-1";
const sessionKey = createSessionKey(environmentId, tabId);
const image = {
  id: "mockup",
  type: "image" as const,
  path: "/workspace/mockup.png",
  name: "mockup.png",
};
const annotation = buildDesignAgentContextAnnotation({
  id: `${tabId}-design-context`,
  canvasId: "canvas-1",
  canvasName: "First design",
});

test("the design opens on its selected provider and sends context and Fast only with the first user message", async () => {
  appCommandStore(configStore)
    .getState()
    .updateGlobalConfig({
      enabledAgentPlatforms: ["claude", "codex", "cursor"],
      agentSettings: { defaultAgent: "cursor" },
    });
  sessionProjectionMock.mockImplementation(async (input) => {
    const projection = await defaultProjection(input);
    const ensured = ensureNativeAgentSessionMock.mock.calls.at(-1)?.[0] as
      Parameters<typeof ensureNativeAgentSession>[0] | undefined;
    const fastMode = ensured?.fastMode === true;
    return {
      ...projection,
      composer: {
        ...projection.composer!,
        models: [{ platform: "codex", id: "gpt-5.4", label: "GPT-5.4", supportsSpeed: true }],
        selectedModelId: "gpt-5.4",
        fastModeEnabled: fastMode,
        fastModeAvailable: true,
      },
    };
  });
  const drafts = appCommandStore(nativeComposeStore);
  drafts.getState().updateDraft(sessionKey, { annotations: [annotation] });
  renderInAppCommandScope(
    <AgentNativeTab
      tabId={tabId}
      data={{ environmentId, platform: "codex" }}
      initialAgentModel="gpt-5.4"
      initialFastMode
      isActive
    />,
  );
  const input = await screen.findByRole("textbox");
  await waitFor(() =>
    expect(ensureNativeAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "codex", fastMode: true }),
    ),
  );
  await screen.findByRole("button", { name: "GPT-5.4 (⚡)" });
  const send = screen.getByRole("button", { name: "Send" });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(send);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(0);

  fireEvent.input(input, { target: { textContent: "/review" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(
    await screen.findByText("Remove the design context before sending a slash command."),
  ).toBeTruthy();
  expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(0);
  expect(drafts.getState().drafts.get(sessionKey)?.annotations).toEqual([annotation]);

  fireEvent.input(input, { target: { textContent: "Make a login page" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
  const [request] = dispatchNativeAgentIntentMock.mock.calls[0]!;
  expect(request.agent).toBe("codex");
  expect(request.model).toBe("gpt-5.4");
  expect(request.fastMode).toBe(true);
  expect(request.prompt).toStartWith(SYSTEM_INSTRUCTIONS_FRAME_OPEN);
  expect(request.prompt).toContain("replaceFingerprint");
  const userPrompt = stripSystemInstructions(request.prompt!);
  expect(userPrompt).toStartWith("Make a login page");
  expect(userPrompt).not.toContain("replaceFingerprint");
  expect(parsePromptTranscriptReferences(userPrompt).references).toEqual([
    {
      reference: 1,
      selectedText: annotation.text,
      source: "design",
      userComment: null,
    },
  ]);
  await waitFor(() =>
    expect(drafts.getState().drafts.get(sessionKey)?.annotations ?? []).toEqual([]),
  );
});

for (const namespace of ["codex", "agent-native"] as const) {
  test(`restores an unsent ${namespace} design draft before launch options can overwrite it`, async () => {
    seedUnassignedDefaultCatalog();
    const draftKey = composeDraftKey(namespace, environmentId, sessionKey);
    await persistComposeDraft(draftKey, "environment", environmentId, {
      text: "Keep this unsent design request",
      mentions: [],
      annotations: [annotation],
      attachments: [image],
      metadata: { platform: "codex", modelId: "gpt-5.4", fastMode: false, mode: "plan" },
    });
    const drafts = appCommandStore(nativeComposeStore);
    const props = {
      tabId,
      data: { environmentId, platform: namespace === "codex" ? ("codex" as const) : undefined },
      initialAgentPlatform: "claude" as const,
      initialAgentModel: "claude-sonnet-5",
      initialConversationMode: "build" as const,
      initialFastMode: true,
      isActive: true,
    };
    renderInAppCommandScope(<AgentNativeTab {...props} />);
    await waitFor(() =>
      expect(screen.getByRole("textbox").textContent).toBe("Keep this unsent design request"),
    );
    expect(drafts.getState().drafts.get(sessionKey)).toMatchObject({
      annotations: [annotation],
      attachments: [image],
      platform: "codex",
      modelId: "gpt-5.4",
      fastMode: false,
      mode: "plan",
    });
    await act(async () => {});
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(0);
  });
}
