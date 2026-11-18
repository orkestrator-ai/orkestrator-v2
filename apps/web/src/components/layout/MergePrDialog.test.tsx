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

  describe("into a branch other than the project's target", () => {
    const targetMismatch = { actual: "dev", configured: "main" };

    test("warns in the options and asks before merging", () => {
      const onMerge = mock(() => {});
      render(
        <MergePrDialog {...props({ targetMismatch, merge: { disabledReason: null, onMerge } })} />,
      );
      expect(screen.getByTestId("merge-target-mismatch").textContent).toContain(
        "This pull request targets dev, not main",
      );
      fireEvent.click(options().getByRole("button", { name: "Merge & Cleanup" }));
      expect(onMerge).not.toHaveBeenCalled();
      const confirmation = screen.getByTestId("merge-non-target-confirmation");
      expect(within(confirmation).getByText("Merge into non-target branch?")).toBeTruthy();
      expect(confirmation.textContent).toContain("Do you wish to accept?");
      fireEvent.click(within(confirmation).getByRole("button", { name: "Accept and merge" }));
      expect(onMerge).toHaveBeenLastCalledWith(true);
    });

    test("cancelling the question returns to the options without merging", () => {
      const onMerge = mock(() => {});
      const onOpenChange = mock((_open: boolean) => {});
      render(
        <MergePrDialog
          {...props({ targetMismatch, onOpenChange, merge: { disabledReason: null, onMerge } })}
        />,
      );
      fireEvent.click(options().getByRole("button", { name: "Merge PR" }));
      fireEvent.click(
        within(screen.getByTestId("merge-non-target-confirmation")).getByRole("button", {
          name: "Cancel",
        }),
      );
      expect(onMerge).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(options().getByRole("button", { name: "Merge PR" })).toBeTruthy();
    });

    test("arming Auto-merge & Cleanup asks too", () => {
      const onArm = mock(() => {});
      render(
        <MergePrDialog
          {...props({
            targetMismatch,
            autoMergeCleanup: { ...props().autoMergeCleanup, onArm },
          })}
        />,
      );
      fireEvent.click(options().getByRole("button", { name: "Auto-merge & Cleanup" }));
      expect(onArm).not.toHaveBeenCalled();
      fireEvent.click(
        within(screen.getByTestId("merge-non-target-confirmation")).getByRole("button", {
          name: "Accept and turn on auto-merge",
        }),
      );
      expect(onArm).toHaveBeenCalledTimes(1);
    });

    test("a reopened dialog starts at the options, not the question", () => {
      const { rerender } = render(<MergePrDialog {...props({ targetMismatch })} />);
      fireEvent.click(options().getByRole("button", { name: "Merge PR" }));
      expect(screen.getByTestId("merge-non-target-confirmation")).toBeTruthy();
      rerender(<MergePrDialog {...props({ targetMismatch, open: false })} />);
      rerender(<MergePrDialog {...props({ targetMismatch, open: true })} />);
      expect(screen.queryByTestId("merge-non-target-confirmation") === null).toBe(true);
      expect(options().getByRole("button", { name: "Merge PR" })).toBeTruthy();
    });
  });

  test("a matching target merges without a question", () => {
    const onMerge = mock(() => {});
    render(
      <MergePrDialog
        {...props({ targetMismatch: null, merge: { disabledReason: null, onMerge } })}
      />,
    );
    expect(screen.queryByTestId("merge-target-mismatch") === null).toBe(true);
    fireEvent.click(options().getByRole("button", { name: "Merge PR" }));
    expect(onMerge).toHaveBeenLastCalledWith(false);
  });
});
