import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Z_FULLSCREEN_DIALOG, Z_FULLSCREEN_DIALOG_POPOVER } from "@/constants/z-index";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

afterEach(() => cleanup());

const repositoryRoot = path.resolve(import.meta.dir, "../../../../..");

describe("AlertDialog primitives", () => {
  test("forwards props, exposes slots, and merges caller classes", () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogTrigger>Open dialog</AlertDialogTrigger>
        <AlertDialogContent
          aria-label="Confirmation"
          className="custom-content"
          overlayClassName="custom-overlay"
        >
          <AlertDialogHeader className="custom-header">
            <AlertDialogTitle className="custom-title">Confirm action</AlertDialogTitle>
            <AlertDialogDescription className="custom-description">This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="custom-footer">
            <AlertDialogCancel className="custom-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction className="custom-action">Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    const dialog = screen.getByRole("alertdialog", { name: "Confirm action" });
    expect(dialog.getAttribute("aria-label")).toBe("Confirmation");
    expect(dialog.dataset.slot).toBe("alert-dialog-content");
    expect(dialog.className).toContain("z-50");
    expect(dialog.className).toContain("custom-content");
    expect(document.querySelector('[data-slot="alert-dialog-overlay"]')?.className).toContain("custom-overlay");
    expect(document.querySelector('[data-slot="alert-dialog-overlay"]')?.className).toContain("z-50");
    expect(screen.getByText("Confirm action").dataset.slot).toBe("alert-dialog-title");
    expect(screen.getByText("This cannot be undone.").dataset.slot).toBe("alert-dialog-description");
    expect(dialog.querySelector('[data-slot="alert-dialog-header"]')?.className).toContain("custom-header");
    expect(dialog.querySelector('[data-slot="alert-dialog-footer"]')?.className).toContain("custom-footer");
    expect(screen.getByRole("button", { name: "Cancel" }).dataset.slot).toBe("alert-dialog-cancel");
    expect(screen.getByRole("button", { name: "Continue" }).dataset.slot).toBe("alert-dialog-action");
  });

  test("runs a caller cancel handler and closes through the Radix cancel behavior", async () => {
    const onClick = mock(() => undefined);
    const onOpenChange = mock((_open: boolean) => undefined);
    render(
      <AlertDialog defaultOpen onOpenChange={onOpenChange}>
        <AlertDialogContent aria-label="Confirmation">
          <AlertDialogTitle>Keep working?</AlertDialogTitle>
          <AlertDialogDescription>Cancel this action.</AlertDialogDescription>
          <AlertDialogCancel onClick={onClick} data-slot="caller-cancel-slot">
            Keep working
          </AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>,
    );

    const cancel = screen.getByRole("button", { name: "Keep working" });
    expect(cancel.dataset.slot).toBe("caller-cancel-slot");
    fireEvent.click(cancel);

    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
  });

  test("keeps a nested portaled select above a default dialog by source order at the same layer", async () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent aria-label="Reattach container">
          <AlertDialogTitle>Reattach container</AlertDialogTitle>
          <AlertDialogDescription>Choose a project.</AlertDialogDescription>
          <Select defaultOpen defaultValue="project-1">
            <SelectTrigger aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project-1">Project One</SelectItem>
              <SelectItem value="project-2">Project Two</SelectItem>
            </SelectContent>
          </Select>
        </AlertDialogContent>
      </AlertDialog>,
    );

    const dialog = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]')!;
    const selectContent = await waitFor(() => document.querySelector<HTMLElement>('[data-slot="select-content"]'));
    expect(selectContent).toBeTruthy();
    expect(selectContent?.className).toContain("z-50");
    expect(dialog.className).toContain("z-50");
    expect(dialog.compareDocumentPosition(selectContent!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Project Two")).toBeTruthy();
  });

  test("requires a nested select to be raised alongside a raised dialog", async () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent
          aria-label="Reattach container"
          className={Z_FULLSCREEN_DIALOG}
          overlayClassName={Z_FULLSCREEN_DIALOG}
        >
          <AlertDialogTitle>Reattach container</AlertDialogTitle>
          <AlertDialogDescription>Choose a project.</AlertDialogDescription>
          <Select defaultOpen defaultValue="project-1">
            <SelectTrigger aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
              <SelectItem value="project-1">Project One</SelectItem>
              <SelectItem value="project-2">Project Two</SelectItem>
            </SelectContent>
          </Select>
        </AlertDialogContent>
      </AlertDialog>,
    );

    const dialog = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]')!;
    const overlay = document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]')!;
    const selectContent = await waitFor(() => document.querySelector<HTMLElement>('[data-slot="select-content"]'));

    // Raising the dialog gives it its own stacking context, so a `z-50` popover
    // portalled to the body would render behind it however late it appears in
    // the DOM. Source order rescues the default case, not this one.
    expect(dialog.className).toContain("z-[80]");
    expect(dialog.className).not.toContain("z-50");
    expect(overlay.className).toContain("z-[80]");
    expect(overlay.className).not.toContain("z-50");
    expect(selectContent?.className).toContain("z-[90]");
    expect(selectContent?.className).not.toContain("z-50");
  });

  test("keeps every dialog opened from a fullscreen surface on the raised layer", () => {
    // A guard against the layering fix being applied to one dialog at a time:
    // each of these is triggered from inside `FullscreenSettingsLayout`, which
    // renders above the shadcn default.
    const sources = [
      "apps/web/src/components/settings/GlobalSettings.tsx",
      "apps/web/src/components/docker/DockerStatsDialog.tsx",
      "apps/web/src/components/environments/EnvironmentSettingsDialog.tsx",
    ];
    for (const source of sources) {
      const text = readFileSync(path.join(repositoryRoot, source), "utf8");
      const contents = text.match(/<AlertDialogContent[\s\S]*?>/g) ?? [];
      expect(contents.length).toBeGreaterThan(0);
      for (const opening of contents) {
        expect({ source, opening }).toMatchObject({
          opening: expect.stringContaining("Z_FULLSCREEN_DIALOG"),
        });
      }
    }
  });
});
