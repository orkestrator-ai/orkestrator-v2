import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesignReadinessView } from "./design-launch";
import { DesignReadinessPanel } from "./DesignReadinessPanel";

afterEach(cleanup);

function view(
  renderer: Partial<DesignReadinessView["renderer"]>,
  extra: Partial<DesignReadinessView> = {},
) {
  return {
    backend: { state: "connected" },
    protocol: "v2",
    capabilities: null,
    storage: { state: "available", canvases: 2, limit: 256 },
    renderer: { state: "ready", ready: true, message: "", ...renderer },
    ...extra,
  } as DesignReadinessView;
}

const allAgents = { claude: true, codex: true };

function show(
  value: DesignReadinessView | null,
  options: {
    loading?: boolean;
    agents?: typeof allAgents;
    selected?: "claude" | "codex" | null;
  } = {},
) {
  const onRetry = mock(() => {});
  render(
    <DesignReadinessPanel
      view={value}
      loading={options.loading ?? false}
      onRetry={onRetry}
      agents={options.agents ?? allAgents}
      selectedAgent={options.selected === undefined ? "claude" : options.selected}
    />,
  );
  return { onRetry, status: screen.getByRole("status") };
}

const fact = (key: string) => document.querySelector(`[data-fact="${key}"]`);

describe("DesignReadinessPanel", () => {
  test("announces checking while the first probe runs", () => {
    const { status } = show(null, { loading: true });
    expect(status.textContent).toBe("Checking design services…");
    expect(
      (screen.getByRole("button", { name: "Retry design readiness checks" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("ready services show every fact", () => {
    const { status } = show(view({}));
    expect(status.textContent).toBe("Design services ready.");
    expect(fact("backend")?.textContent).toContain("Connected");
    expect(fact("storage")?.textContent).toContain("2 of 256 designs used");
    expect(fact("renderer")?.textContent).toContain("Renderer ready");
    expect(fact("agent")?.textContent).toContain("Claude is enabled");
  });

  test("missing Chromium gives install guidance and keeps other actions available", () => {
    const { status } = show(
      view({ state: "missing-executable", ready: false, executableConfigured: false }),
    );
    expect(status.textContent).toContain("Chromium is not installed on this backend");
    expect(status.textContent).toContain("still open, rename, export and import");
    expect(fact("renderer")?.textContent).toContain("ORKESTRATOR_DESIGN_CHROMIUM_PATH");
    expect(fact("renderer")?.getAttribute("data-tone")).toBe("error");
  });

  test("a misconfigured custom path is distinguished from a missing install", () => {
    show(view({ state: "missing-executable", ready: false, executableConfigured: true }));
    expect(fact("renderer")?.textContent).toContain("custom browser path is configured");
  });

  test("launch failure, recovery and a full queue each have distinct text", () => {
    show(view({ state: "launch-failed", ready: false, message: "exit code 127" }));
    expect(fact("renderer")?.textContent).toContain("failed to launch");
    expect(fact("renderer")?.textContent).toContain("exit code 127");
    cleanup();
    show(view({ state: "recovering", ready: false }));
    expect(fact("renderer")?.textContent).toContain("restarting after a failure");
    expect(fact("renderer")?.getAttribute("data-tone")).toBe("warn");
    cleanup();
    show(view({ state: "saturated", ready: false, queued: 16 }));
    expect(fact("renderer")?.textContent).toContain("queue is temporarily full");
    expect(fact("renderer")?.textContent).toContain("16 render jobs are waiting");
  });

  test("a disconnected backend hides storage and renderer guesses", () => {
    const { status } = show(view({}, { backend: { state: "disconnected" } }));
    expect(status.textContent).toBe("Design backend disconnected.");
    expect(fact("renderer")).toBeNull();
    expect(fact("storage")).toBeNull();
  });

  test("an old backend is labelled", () => {
    show(view({}, { protocol: "v1", storage: { state: "unknown" } }));
    expect(fact("backend")?.textContent).toContain("older design backend");
    expect(fact("storage")?.textContent).toContain("Not reported");
  });

  test("a disabled agent suggests the available alternative; blank needs no agent", () => {
    show(view({}), { agents: { claude: false, codex: true } });
    expect(fact("agent")?.textContent).toContain("Claude is disabled in Settings");
    expect(fact("agent")?.textContent).toContain("choose Codex");
    cleanup();
    show(view({}), { selected: null });
    expect(fact("agent")?.textContent).toContain("Blank canvas");
  });

  test("Retry asks for a new probe", () => {
    const { onRetry } = show(view({ state: "launch-failed", ready: false }));
    fireEvent.click(screen.getByRole("button", { name: "Retry design readiness checks" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
