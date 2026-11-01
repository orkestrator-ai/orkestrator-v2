import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDialogFocusReturn } from "./dialog-focus";

/** A startup notice: opened by the app, not by a trigger the user pressed. */
function Notice({ open, returnFocus }: { open: boolean; returnFocus: boolean }) {
  const focusReturn = useDialogFocusReturn();
  return (
    <>
      <button type="button">Annotations</button>
      <AlertDialog open={open}>
        <AlertDialogContent {...(returnFocus ? focusReturn : {})}>
          <AlertDialogTitle>GitHub CLI Not Found</AlertDialogTitle>
          <AlertDialogDescription>Some features need it.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The notice opens over a focused control; pressing Continue moves focus to it, then closes it. */
async function openOverControlAndContinue(returnFocus: boolean): Promise<HTMLElement> {
  const { rerender } = render(<Notice open={false} returnFocus={returnFocus} />);
  const control = screen.getByRole("button", { name: "Annotations" });
  control.focus();
  rerender(<Notice open returnFocus={returnFocus} />);
  const action = await screen.findByRole("button", { name: "Continue" });
  action.focus();
  fireEvent.click(action);
  rerender(<Notice open={false} returnFocus={returnFocus} />);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  return control;
}

describe("useDialogFocusReturn", () => {
  afterEach(cleanup);

  test("returns focus to the control a triggerless dialog took it from", async () => {
    const control = await openOverControlAndContinue(true);
    await waitFor(() => expect(document.activeElement).toBe(control));
  });

  test("without it, Radix leaves focus on the document body", async () => {
    await openOverControlAndContinue(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(document.body);
  });
});
