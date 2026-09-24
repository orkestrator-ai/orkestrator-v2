import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { resetCapabilities } from "./design-client";
import { DesignEnvironmentDeletionNotice } from "./DesignEnvironmentDeletionNotice";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function entry(id: string, exported?: { outdated: boolean }) {
  return {
    id,
    name: id,
    revision: 3,
    modifiedAt: "",
    createdAt: "",
    frameCount: 1,
    state: "live",
    validation: { invalid: 0, unvalidated: 0 },
    ...(exported ? { export: { relativePath: `${id}.orkdes`, revision: 3, ...exported } } : {}),
  };
}

describe("DesignEnvironmentDeletionNotice", () => {
  beforeEach(() => resetCapabilities());
  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("explains that workspace designs are deleted and which were never exported", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "design_capabilities")
        return { ok: true, value: { protocolVersion: 2, library: true } };
      if (command === "design_library")
        return {
          ok: true,
          value: {
            entries: [entry("a"), entry("b", { outdated: true }), entry("c", { outdated: false })],
            total: 3,
          },
        };
      throw new Error(`Unknown backend command: ${command}`);
    });
    render(<DesignEnvironmentDeletionNotice environmentId="env-1" open />);
    const notice = await screen.findByTestId("design-deletion-notice");
    expect(notice.textContent).toContain("3 designs");
    expect(notice.textContent).toContain("2 have changes that were never exported");
  });

  test("shows nothing for an old backend or when the dialog is closed", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      throw new Error(`Unknown backend command: ${command}`);
    });
    const { rerender } = render(<DesignEnvironmentDeletionNotice environmentId="env-1" open />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryAllByTestId("design-deletion-notice")).toHaveLength(0);
    rerender(<DesignEnvironmentDeletionNotice environmentId="env-1" open={false} />);
    expect(screen.queryAllByTestId("design-deletion-notice")).toHaveLength(0);
  });
});
