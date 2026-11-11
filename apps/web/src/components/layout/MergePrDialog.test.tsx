import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MergePrDialog, prMergeability, type MergePrDialogProps } from "./MergePrDialog";

afterEach(cleanup);

function props(overrides: Partial<MergePrDialogProps> = {}): MergePrDialogProps {
  return {
    open: true,
    onOpenChange: () => {},
    mergeability: "mergeable",
    sourceBranch: "feature",
    targetBranch: "main",
    deletesBranch: true,
    mergeError: null,
    merge: { disabledReason: null, onMerge: () => {} },
    resolve: { disabledReason: null, busy: false, onResolve: () => {}, onConfigure: null },
    autoMergeCleanup: {
      disabledReason: null,
      active: false,
      saving: false,
      hold: null,
      onArm: () => {},
    },
    ...overrides,
  };
}

function options() {
  return within(screen.getByRole("group", { name: "Merge options" }));
}

describe("prMergeability", () => {
  test("maps GitHub's conflict reading onto the button's three states", () => {
    expect(prMergeability(false)).toBe("mergeable");
    expect(prMergeability(true)).toBe("conflicts");
    expect(prMergeability(null)).toBe("checking");
    expect(prMergeability(undefined)).toBe("checking");
  });
});

describe("MergePrDialog", () => {
  test("offers merge, merge & cleanup, resolve and auto-merge & cleanup", () => {
    const onMerge = mock(() => {});
    const onArm = mock(() => {});
    render(
      <MergePrDialog
        {...props({
          merge: { disabledReason: null, onMerge },
          autoMergeCleanup: { ...props().autoMergeCleanup, onArm },
        })}
      />,
    );
    fireEvent.click(options().getByRole("button", { name: "Merge PR" }));
    expect(onMerge).toHaveBeenLastCalledWith(false);
    fireEvent.click(options().getByRole("button", { name: "Merge & Cleanup" }));
    expect(onMerge).toHaveBeenLastCalledWith(true);
    fireEvent.click(options().getByRole("button", { name: "Auto-merge & Cleanup" }));
    expect(onArm).toHaveBeenCalledTimes(1);
    expect(options().getByRole("button", { name: "Resolve" })).toBeTruthy();
  });

  test("a wait auto-merge cannot end by itself is named before the user chooses", () => {
    render(
      <MergePrDialog
        {...props({
          autoMergeCleanup: {
            ...props().autoMergeCleanup,
            hold: { message: "2 checks failed", transient: false },
          },
        })}
      />,
    );
    expect(options().getByRole("note").textContent).toBe("Auto-merge will wait: 2 checks failed");
  });

  test("a wait that ends on its own adds no note", () => {
    render(
      <MergePrDialog
        {...props({
          autoMergeCleanup: {
            ...props().autoMergeCleanup,
            hold: { message: "2 checks running", transient: true },
          },
        })}
      />,
    );
    expect(options().queryByRole("note") === null).toBe(true);
  });

  test("a disabled option says why in place of its description", () => {
    render(
      <MergePrDialog
        {...props({
          autoMergeCleanup: {
            ...props().autoMergeCleanup,
            disabledReason: "Never deleted.",
          },
        })}
      />,
    );
    const button = options().getByRole("button", {
      name: "Auto-merge & Cleanup",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(options().getByText("Never deleted.")).toBeTruthy();
  });

  test("leaves out Resolve and Merge & Cleanup where the surface cannot offer them", () => {
    const onMerge = mock(() => {});
    render(
      <MergePrDialog
        {...props({
          merge: { disabledReason: null, onMerge, offerCleanup: false },
          resolve: null,
        })}
      />,
    );
    expect(options().queryByRole("button", { name: "Resolve" }) === null).toBe(true);
    expect(options().queryByRole("button", { name: "Merge & Cleanup" }) === null).toBe(true);
    expect(options().getByRole("button", { name: "Auto-merge & Cleanup" })).toBeTruthy();
    fireEvent.click(options().getByRole("button", { name: "Merge PR" }));
    expect(onMerge).toHaveBeenLastCalledWith(false);
  });
});
