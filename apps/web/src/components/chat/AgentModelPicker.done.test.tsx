import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AgentModelPicker } from "./AgentModelPicker";

function setMobileViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 767px)" ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

const TITLE = "Choose model, reasoning, and speed";

const models = [
  { platform: "claude" as const, id: "claude-model", label: "Claude model" },
  ...Array.from({ length: 3 }, (_, index) => ({
    platform: "codex" as const,
    id: `model-${index + 1}`,
    label: `Model ${index + 1}`,
  })),
];

const reasoningOptions = [
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
];

// Holds the selection in state like a real caller, so a test can see that
// Done leaves the choices made before it in place.
function StatefulPicker({
  onModelChange,
  onPlatformChange,
  onReasoningChange,
  onFastModeChange,
}: {
  onModelChange: (modelId: string) => void;
  onPlatformChange: (platform: AgentPlatform) => void;
  onReasoningChange: (reasoningId: string) => void;
  onFastModeChange: (enabled: boolean) => void;
}) {
  const [modelId, setModelId] = useState("claude-model");
  const [platform, setPlatform] = useState<AgentPlatform>("claude");
  const [reasoningId, setReasoningId] = useState("high");
  const [fast, setFast] = useState(false);
  const reasoning = reasoningOptions.find((option) => option.id === reasoningId);
  return (
    <AgentModelPicker
      models={models}
      selectedPlatform={platform}
      enabledPlatforms={["claude", "codex"]}
      onPlatformChange={(next) => {
        setPlatform(next);
        onPlatformChange(next);
      }}
      selectedModelId={modelId}
      selectedModelLabel={models.find((model) => model.id === modelId)?.label ?? modelId}
      onModelChange={(id) => {
        setModelId(id);
        onModelChange(id);
      }}
      reasoningOptions={reasoningOptions}
      selectedReasoningId={reasoningId}
      selectedReasoningLabel={reasoning?.label}
      onReasoningChange={(id) => {
        setReasoningId(id);
        onReasoningChange(id);
      }}
      fastModeEnabled={fast}
      fastModeAvailable
      onFastModeChange={(enabled) => {
        setFast(enabled);
        onFastModeChange(enabled);
      }}
    />
  );
}

function renderPicker() {
  const onPlatformChange = mock((_platform: AgentPlatform) => {});
  const onModelChange = mock((_modelId: string) => {});
  const onReasoningChange = mock((_reasoningId: string) => {});
  const onFastModeChange = mock((_enabled: boolean) => {});
  render(
    <StatefulPicker
      onModelChange={onModelChange}
      onPlatformChange={onPlatformChange}
      onReasoningChange={onReasoningChange}
      onFastModeChange={onFastModeChange}
    />,
  );
  return { onModelChange, onPlatformChange, onReasoningChange, onFastModeChange };
}

function openPicker() {
  const trigger = screen.getByTitle(TITLE);
  fireEvent.pointerDown(trigger);
  return trigger;
}

function pickerContent() {
  return document.querySelector("[data-native-model-picker]");
}

function doneButton() {
  return screen.getByRole("button", { name: "Done" });
}

async function expectClosed() {
  await waitFor(() => expect(pickerContent() === null).toBe(true));
}

describe("AgentModelPicker Done button", () => {
  afterEach(() => cleanup());

  test("sits after the search input on the same row and uses the design-system button", () => {
    setMobileViewport(false);
    renderPicker();
    openPicker();

    const search = screen.getByPlaceholderText("Search models...");
    const done = doneButton();
    expect(done.parentElement).toBe(search.parentElement);
    expect(search.nextElementSibling).toBe(done);
    expect(done.getAttribute("type")).toBe("button");
    expect(done.getAttribute("data-slot")).toBe("button");
    expect(done.className).toContain("focus-hairline");
    expect(done.className).toContain("shrink-0");
    expect(search.className).toContain("min-w-0");
    expect(search.className).toContain("flex-1");
  });

  test("renders beside the search field on mobile too", () => {
    setMobileViewport(true);
    renderPicker();
    openPicker();

    const search = screen.getByPlaceholderText("Search models...");
    expect(search.nextElementSibling).toBe(doneButton());
  });

  test("closes the popover and keeps the agent, model, reasoning and speed chosen before it", async () => {
    setMobileViewport(false);
    const { onModelChange, onPlatformChange, onReasoningChange, onFastModeChange } = renderPicker();
    const trigger = openPicker();

    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Model 3/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Low" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fast/ }));
    expect(onPlatformChange).toHaveBeenCalledWith("codex");
    const platformCalls = onPlatformChange.mock.calls.length;
    expect(onModelChange).toHaveBeenCalledWith("model-3");
    expect(onReasoningChange).toHaveBeenCalledWith("low");
    expect(onFastModeChange).toHaveBeenCalledWith(true);

    fireEvent.click(doneButton());
    await expectClosed();

    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onReasoningChange).toHaveBeenCalledTimes(1);
    expect(onFastModeChange).toHaveBeenCalledTimes(1);
    expect(onPlatformChange).toHaveBeenCalledTimes(platformCalls);
    fireEvent.pointerDown(trigger);
    expect(screen.getByRole("button", { name: "codex models" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      screen.getByRole("menuitemradio", { name: /Model 3/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(trigger.textContent).toContain("Model 3");
    expect(trigger.textContent).toContain("Low");
    expect(trigger.textContent).toContain("⚡");
  });

  test("makes no selection when nothing was chosen", async () => {
    setMobileViewport(false);
    const { onModelChange, onReasoningChange, onFastModeChange } = renderPicker();
    openPicker();
    fireEvent.click(doneButton());
    await expectClosed();

    expect(onModelChange).not.toHaveBeenCalled();
    expect(onReasoningChange).not.toHaveBeenCalled();
    expect(onFastModeChange).not.toHaveBeenCalled();
  });

  test("leaves native keyboard defaults uncanceled on Done", () => {
    setMobileViewport(false);
    renderPicker();
    openPicker();
    // Native traversal, activation and focus return are exercised in the
    // Playwright AgentModelPicker spec; happy-dom only dispatches events.
    for (const key of ["Enter", " ", "Tab"]) {
      expect(fireEvent.keyDown(doneButton(), { key })).toBe(true);
    }
  });

  test("clears the search and reopens on the full list after Done", async () => {
    setMobileViewport(false);
    renderPicker();
    const trigger = openPicker();
    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "model 2" },
    });
    expect(screen.getByText("1 model found")).toBeTruthy();

    fireEvent.click(doneButton());
    await expectClosed();

    fireEvent.pointerDown(trigger);
    expect((screen.getByPlaceholderText("Search models...") as HTMLInputElement).value).toBe("");
  });

  test("leaves Escape closing the popover", async () => {
    setMobileViewport(false);
    renderPicker();
    openPicker();
    fireEvent.keyDown(screen.getByPlaceholderText("Search models..."), { key: "Escape" });
    await expectClosed();
  });

  test("closes the popover without closing the dialog that contains it", async () => {
    setMobileViewport(false);
    const onDialogOpenChange = mock((_open: boolean) => {});
    const onModelChange = mock((_modelId: string) => {});
    function DialogHost() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            onDialogOpenChange(next);
            setOpen(next);
          }}
        >
          <DialogContent>
            <DialogTitle>Restart build</DialogTitle>
            <AgentModelPicker
              models={models}
              selectedPlatform="codex"
              selectedModelId="model-1"
              selectedModelLabel="Model 1"
              onModelChange={onModelChange}
              reasoningOptions={[]}
              onReasoningChange={() => {}}
            />
          </DialogContent>
        </Dialog>
      );
    }
    render(<DialogHost />);

    fireEvent.pointerDown(screen.getByTitle("Choose model"));
    const done = doneButton();
    fireEvent.pointerDown(done);
    fireEvent.click(done);
    await expectClosed();

    expect(onDialogOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Restart build" })).toBeTruthy();
    expect(onModelChange).not.toHaveBeenCalled();
  });
});
