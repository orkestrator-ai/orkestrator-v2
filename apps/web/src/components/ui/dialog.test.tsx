import type * as React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

afterEach(cleanup);

const repositoryRoot = path.resolve(import.meta.dir, "../../../../..");

describe("Dialog primitives", () => {
  test("merges caller styles and overlay classes without terminal-theme overrides", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent
          aria-describedby={undefined}
          overlayClassName="custom-overlay"
          style={
            {
              "--color-background": "#123456",
              color: "rgb(1, 2, 3)",
            } as React.CSSProperties
          }
        >
          <DialogHeader>
            <DialogTitle>Styled dialog</DialogTitle>
          </DialogHeader>
          <DialogFooter>Actions</DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Styled dialog" });
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    const header = dialog.querySelector<HTMLElement>('[data-slot="dialog-header"]');
    const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]');

    expect(dialog.style.getPropertyValue("--color-background")).toBe("#123456");
    expect(dialog.style.color).toBe("rgb(1, 2, 3)");
    expect(overlay?.className).toContain("custom-overlay");
    expect(header?.className).toContain("pr-12");
    expect(footer?.className).not.toContain("bg-background/30");
  });

  test("drops close-button header clearance when the close button is hidden", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined} showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Persistent dialog</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Persistent dialog" });
    expect(dialog.querySelector('[data-slot="dialog-header"]')?.className).not.toContain("pr-12");
    expect(screen.queryByRole("button", { name: "Close" }) === null).toBe(true);
  });

  test("keeps modal contrast independent of a light terminal background", () => {
    const originalConfig = useConfigStore.getState().config;
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          terminalAppearance: {
            ...state.config.global.terminalAppearance,
            backgroundColor: "#ffffff",
          },
        },
      },
    }));

    try {
      render(
        <Dialog defaultOpen>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Readable dialog</DialogTitle>
          </DialogContent>
        </Dialog>,
      );

      const dialog = screen.getByRole("dialog", { name: "Readable dialog" });
      expect(dialog.className).toContain("bg-background");
      expect(dialog.style.getPropertyValue("--color-background")).toBe("");
    } finally {
      useConfigStore.setState({ config: originalConfig });
    }
  });

  test("does not add a same-color translucent background to modal footers", () => {
    const footerConsumers = [
      "apps/web/src/components/build/BuildLaunchDialog.tsx",
      "apps/web/src/components/environments/CreateEnvironmentDialog.tsx",
      "apps/web/src/components/launch/AgentLaunchDialog.tsx",
      "apps/web/src/components/review/MultiReviewLaunchDialog.tsx",
      "apps/web/src/components/review/ReviewLaunchDialog.tsx",
      "apps/web/src/components/sidebar/ServerConnectionSwitcher.tsx",
    ];

    for (const source of footerConsumers) {
      const contents = readFileSync(path.join(repositoryRoot, source), "utf8");
      expect(contents).not.toMatch(/<DialogFooter[^>]*bg-background\/30/);
    }
  });

  test("keeps every dialog opened from a fullscreen surface on the raised layer", () => {
    // Ordinary dialogs need the same explicit content and overlay layers as
    // alert dialogs when they are portalled out of a fullscreen surface.
    const sources = ["apps/web/src/components/settings/ConnectionsSettings.tsx"];

    for (const source of sources) {
      const text = readFileSync(path.join(repositoryRoot, source), "utf8");
      const contents = text.match(/<DialogContent[\s\S]*?>/g) ?? [];
      expect(contents.length).toBeGreaterThan(0);
      for (const opening of contents) {
        expect({ source, opening }).toMatchObject({
          opening: expect.stringMatching(/className=\{cn\([\s\S]*Z_FULLSCREEN_DIALOG[\s\S]*\)\}/),
        });
        expect({ source, opening }).toMatchObject({
          opening: expect.stringMatching(/overlayClassName=\{Z_FULLSCREEN_DIALOG\}/),
        });
      }
    }
  });
});
