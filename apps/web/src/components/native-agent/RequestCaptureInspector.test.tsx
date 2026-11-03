import { afterEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as backend from "@/lib/backend/agent-accounts";
import { RequestCaptureInspector } from "./RequestCaptureInspector";
afterEach(() => cleanup());
test("loads authoritative history, displays exact body sections and switches capture explicitly", async () => {
  const snapshot = {
    enabled: false,
    files: [{ name: "attempt.request.json", bytes: 100, timestamp: "2026-11-03T17:30:00Z" }],
    index: {
      "attempt.request.json": { requestId: "req_fixture", pairedFile: "req_fixture.response.json" },
    },
  };
  const call = spyOn(backend, "machineInvoke").mockImplementation(
    async <T,>(
      _machine: backend.AccountMachine,
      _command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      if (args?.name)
        return {
          body: { system: "Fixture system", tools: [{ name: "FixtureTool" }], messages: [] },
        } as T;
      return { ...snapshot, enabled: args?.enabled === true } as T;
    },
  );
  try {
    render(<RequestCaptureInspector environmentId="fixture-env" />);
    fireEvent.click(screen.getByRole("button", { name: "API request inspector" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Enable capture for new processes" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable capture for new processes" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Disable capture for new processes" }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Request ·/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("Captured body").textContent).toContain("Fixture system"),
    );
    expect(screen.getByLabelText("Captured body").textContent).toContain("FixtureTool");
    expect(screen.getByRole("button", { name: "View paired request / response" })).toBeTruthy();
    expect(call).toHaveBeenCalledWith(undefined, "claude_request_capture", {
      environmentId: "fixture-env",
      enabled: true,
    });
  } finally {
    call.mockRestore();
  }
});
test("shows bridge errors without enabling capture", async () => {
  const call = spyOn(backend, "machineInvoke").mockRejectedValue(
    new Error("Start a Claude session first"),
  );
  try {
    render(<RequestCaptureInspector environmentId="fixture-env" />);
    fireEvent.click(screen.getByRole("button", { name: "API request inspector" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Start a Claude session first"),
    );
    expect(
      screen
        .getByRole("button", { name: "Enable capture for new processes" })
        .hasAttribute("disabled"),
    ).toBe(true);
  } finally {
    call.mockRestore();
  }
});
