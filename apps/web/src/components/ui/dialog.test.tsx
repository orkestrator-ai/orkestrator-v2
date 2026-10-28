import type * as React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { MODAL_SIZE_CLASS_NAME, MODAL_WIDTH_CLASS_NAME, type ModalSize } from "./modal-theme";

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
    const sources = [
      "apps/web/src/components/layout/KeyboardShortcutsDialog.tsx",
      "apps/web/src/components/settings/machines/AddMachineDialog.tsx",
      "apps/web/src/components/settings/machines/DeviceConnectionSection.tsx",
      "apps/web/src/components/settings/machines/MachineSettingsDialog.tsx",
      "apps/web/src/components/settings/machines/MachineUpdatesDialog.tsx",
      "apps/web/src/components/settings/machines/SshRouteDialog.tsx",
    ];

    for (const source of sources) {
      const text = readFileSync(path.join(repositoryRoot, source), "utf8");
      const contents = text.match(/<DialogContent[\s\S]*?>/g) ?? [];
      expect(contents.length).toBeGreaterThan(0);
      for (const opening of contents) {
        expect({ source, opening }).toMatchObject({
          opening: expect.stringMatching(
            /className=\{(?:Z_FULLSCREEN_DIALOG|cn\([\s\S]*Z_FULLSCREEN_DIALOG[\s\S]*\))\}/,
          ),
        });
        expect({ source, opening }).toMatchObject({
          opening: expect.stringMatching(/overlayClassName=\{Z_FULLSCREEN_DIALOG\}/),
        });
      }
    }
  });
});

describe("DialogContent width", () => {
  const renderDialog = (props: React.ComponentProps<typeof DialogContent> = {}) => {
    render(
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined} {...props}>
          <DialogTitle>Sized dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    return screen.getByRole("dialog", { name: "Sized dialog" });
  };
  const widthClasses = (dialog: HTMLElement) =>
    [...dialog.classList].filter((name) => /(^|:)max-w-|--modal-/.test(name));

  test("defaults to the lg cap from sm, keeping the viewport gutters, instead of full width", () => {
    const dialog = renderDialog();

    expect(widthClasses(dialog)).toEqual([
      "[--modal-limit:calc(100%-1rem)]",
      "sm:[--modal-limit:min(var(--modal-max-width),calc(100%-2rem))]",
      "max-w-(--modal-limit)",
      "[--modal-max-width:32rem]",
    ]);
    // The cap has no breakpoint prefix, so nothing in the base classes can
    // outrank a caller's width from `sm` up.
    expect(MODAL_WIDTH_CLASS_NAME).not.toMatch(/sm:max-w-/);
    expect(dialog.className).not.toContain("max-w-[calc(100%-2rem)]");
  });

  const expectedWidths: Record<ModalSize, string> = {
    sm: "24rem",
    md: "28rem",
    lg: "32rem",
    xl: "36rem",
    "2xl": "42rem",
    "3xl": "48rem",
    "4xl": "56rem",
    "5xl": "64rem",
    "6xl": "72rem",
    full: "100%",
  };

  for (const [size, width] of Object.entries(expectedWidths) as [ModalSize, string][]) {
    test(`size="${size}" caps the dialog at ${width}`, () => {
      const dialog = renderDialog({ size });

      expect(MODAL_SIZE_CLASS_NAME[size]).toBe(`[--modal-max-width:${width}]`);
      expect(dialog.classList.contains(`[--modal-max-width:${width}]`)).toBe(true);
      expect(dialog.classList.contains("[--modal-max-width:32rem]")).toBe(size === "lg");
      expect(dialog.classList.contains("max-w-(--modal-limit)")).toBe(true);
    });
  }

  test("lets an unprefixed className max-width replace the cap at every breakpoint", () => {
    const dialog = renderDialog({ className: "max-w-2xl" });

    expect(widthClasses(dialog)).toEqual([
      "[--modal-limit:calc(100%-1rem)]",
      "sm:[--modal-limit:min(var(--modal-max-width),calc(100%-2rem))]",
      "[--modal-max-width:32rem]",
      "max-w-2xl",
    ]);
  });

  test("lets a className width outside the scale keep the gutter", () => {
    const dialog = renderDialog({ size: "md", className: "[--modal-max-width:34rem]" });

    expect(dialog.classList.contains("[--modal-max-width:34rem]")).toBe(true);
    expect(dialog.classList.contains("[--modal-max-width:28rem]")).toBe(false);
    expect(dialog.classList.contains("max-w-(--modal-limit)")).toBe(true);
  });

  test("lets an sm-prefixed className max-width win from sm", () => {
    const dialog = renderDialog({ className: "sm:max-w-[30rem]" });

    // The base cap stays for phones; tailwind-merge keeps both because the
    // caller's breakpoint outranks the unprefixed cap from sm up.
    expect(dialog.classList.contains("max-w-(--modal-limit)")).toBe(true);
    expect(dialog.classList.contains("sm:max-w-[30rem]")).toBe(true);
  });

  test("keeps callers on size or --modal-max-width rather than max-w classes", () => {
    // An unprefixed max-w-* used to lose to the base sm:max-w-* and open the
    // dialog at nearly full window width, so callers size modals through the
    // API instead of competing max-width classes.
    const sourceRoot = path.join(repositoryRoot, "apps/web/src");
    const offenders: string[] = [];
    for (const entry of readdirSync(sourceRoot, { recursive: true })) {
      const source = String(entry);
      if (!source.endsWith(".tsx") || source.endsWith(".test.tsx")) continue;
      if (source.startsWith(path.join("components", "ui"))) continue;
      const text = readFileSync(path.join(sourceRoot, source), "utf8");
      for (const opening of text.match(/<(?:Alert)?DialogContent\b[\s\S]*?\n?\s*>/g) ?? []) {
        if (/(?:^|[\s"'`:])max-w-/.test(opening)) offenders.push(`${source}: ${opening}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
