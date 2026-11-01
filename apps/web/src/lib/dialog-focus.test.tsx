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
import { useDialogFocusReturn, useDialogFocusReturnGroup } from "./dialog-focus";

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

afterEach(cleanup);

describe("useDialogFocusReturn", () => {
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

function NoticeSequence({ first, second }: { first: boolean; second: boolean }) {
  const group = useDialogFocusReturnGroup();
  const firstFocus = useDialogFocusReturn(group);
  const secondFocus = useDialogFocusReturn(group);
  return (
    <>
      <button type="button">Original control</button>
      {[
        {
          open: first,
          focus: firstFocus,
          title: "Claude login",
          action: "Continue Without Claude",
        },
        {
          open: second,
          focus: secondFocus,
          title: "GitHub setup",
          action: "Continue Without GitHub CLI",
        },
      ].map(({ open, focus, title, action }) => (
        <AlertDialog key={title} open={open}>
          <AlertDialogContent {...focus}>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>Startup notice</AlertDialogDescription>
            <AlertDialogAction>{action}</AlertDialogAction>
          </AlertDialogContent>
        </AlertDialog>
      ))}
    </>
  );
}

for (const order of ["chain", "overlap-close-first", "overlap-close-second"] as const) {
  test(`restores the original control after notices ${order}`, async () => {
    const { rerender } = render(<NoticeSequence first={false} second={false} />);
    const control = screen.getByRole("button", { name: "Original control" });
    control.focus();
    rerender(<NoticeSequence first second={false} />);
    const claude = await screen.findByRole("button", { name: "Continue Without Claude" });
    claude.focus();
    if (order === "chain") {
      fireEvent.click(claude);
      rerender(<NoticeSequence first={false} second />);
    } else {
      rerender(<NoticeSequence first second />);
    }
    const github = await screen.findByRole("button", { name: "Continue Without GitHub CLI" });
    github.focus();
    if (order === "overlap-close-first") {
      rerender(<NoticeSequence first={false} second />);
      await waitFor(() => expect(screen.queryByText("Claude login")).toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.activeElement).toBe(github);
    } else if (order === "overlap-close-second") {
      fireEvent.click(github);
      rerender(<NoticeSequence first second={false} />);
      await waitFor(() => expect(screen.queryByText("GitHub setup")).toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.activeElement).not.toBe(control);
    }
    rerender(<NoticeSequence first={false} second={false} />);
    await waitFor(() => expect(document.activeElement).toBe(control));
  });
}
