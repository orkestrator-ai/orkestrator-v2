import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import * as realStores from "@/stores";
import type { Environment } from "@/types";

const realBackendSnapshot = { ...realBackend };
const realStoresSnapshot = { ...realStores };
const globalAllowedDomains = ["global.example.com"];
const testDomainResolutionMock = mock(async () => [
  { domain: "api.example.com", valid: true, resolvable: true },
]);
const updateEnvironmentAllowedDomainsMock = mock(
  async (_environmentId: string, domains: string[]) => ({
    ...environment,
    allowedDomains: domains,
  }),
);

const environment: Environment = {
  id: "env-1",
  projectId: "project-1",
  name: "Review environment",
  branch: "feature/review",
  containerId: "container-1",
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-07-28T00:00:00.000Z",
  networkAccessMode: "restricted",
  allowedDomains: ["custom.example.com"],
  order: 0,
  environmentType: "containerized",
};

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  testDomainResolution: testDomainResolutionMock,
  updateEnvironmentAllowedDomains: updateEnvironmentAllowedDomainsMock,
}));

mock.module("@/stores", () => ({
  ...realStoresSnapshot,
  useConfigStore: <T,>(selector: (state: {
    config: { global: { allowedDomains: string[] } };
  }) => T) => selector({
    config: { global: { allowedDomains: globalAllowedDomains } },
  }),
}));

const { NetworkWhitelistDialog } = await import("./NetworkWhitelistDialog");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/stores", () => realStoresSnapshot);
});

describe("NetworkWhitelistDialog", () => {
  beforeEach(() => {
    testDomainResolutionMock.mockReset();
    testDomainResolutionMock.mockResolvedValue([
      { domain: "api.example.com", valid: true, resolvable: true },
    ]);
    updateEnvironmentAllowedDomainsMock.mockReset();
    updateEnvironmentAllowedDomainsMock.mockImplementation(
      async (_environmentId, domains) => ({ ...environment, allowedDomains: domains }),
    );
  });

  afterEach(cleanup);

  test("validates, tests, and saves a normalized custom whitelist", async () => {
    const onOpenChange = mock(() => undefined);
    const onUpdate = mock(() => undefined);
    render(
      <NetworkWhitelistDialog
        open
        onOpenChange={onOpenChange}
        environment={environment}
        onUpdate={onUpdate}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "Allowed Domains" });
    fireEvent.change(textarea, { target: { value: "not a domain" } });
    expect(screen.getByText("Invalid domain format: not a domain")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled)
      .toBe(true);

    fireEvent.change(textarea, {
      target: { value: " api.example.com \n\nregistry.example.org " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test DNS Resolution" }));
    await waitFor(() => {
      expect(testDomainResolutionMock).toHaveBeenCalledWith([
        "api.example.com",
        "registry.example.org",
      ]);
      expect(screen.getByText("DNS Test Results:")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(updateEnvironmentAllowedDomainsMock).toHaveBeenCalledWith(
        "env-1",
        ["api.example.com", "registry.example.org"],
      );
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
        allowedDomains: ["api.example.com", "registry.example.org"],
      }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("clears custom domains when global defaults are selected", async () => {
    const onOpenChange = mock(() => undefined);
    render(
      <NetworkWhitelistDialog
        open
        onOpenChange={onOpenChange}
        environment={environment}
        onUpdate={mock(() => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("switch"));
    expect((screen.getByRole("textbox", { name: "Allowed Domains" }) as HTMLTextAreaElement).value)
      .toBe("global.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(updateEnvironmentAllowedDomainsMock).toHaveBeenCalledWith("env-1", []);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("does not expose whitelist mutation controls for full network access", () => {
    render(
      <NetworkWhitelistDialog
        open
        onOpenChange={mock(() => undefined)}
        environment={{ ...environment, networkAccessMode: "full" }}
        onUpdate={mock(() => undefined)}
      />,
    );

    expect(screen.getByText("Full Network Access")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Allowed Domains" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Save Changes" }) === null).toBe(true);
  });
});
