import { afterEach, describe, expect, test } from "bun:test";
import { formatErrorContext, useErrorDialogStore, type ErrorContext } from "./errorDialogStore";

afterEach(() => {
  useErrorDialogStore.getState().closeError();
});

describe("formatErrorContext", () => {
  test.each([
    [{ project: "Project", environment: "Environment" }, "Project / Environment"],
    [{ environment: "Environment" }, "Environment"],
    [{ project: "Project" }, "Project"],
    [{ project: "", environment: "Environment" }, "Environment"],
    [{ project: "Project", environment: "" }, "Project"],
    [{}, ""],
    [{ project: "", environment: "" }, ""],
    [undefined, ""],
  ] satisfies Array<[ErrorContext | undefined, string]>)(
    "formats %j as %j",
    (context, expected) => {
      expect(formatErrorContext(context)).toBe(expected);
    },
  );
});

describe("error dialog context", () => {
  test("preserves partial context and an initial prompt", () => {
    useErrorDialogStore.getState().showError("Start failed", "Full error", "Recover me", {
      environment: "Environment",
    });

    expect(useErrorDialogStore.getState().error).toMatchObject({
      title: "Start failed",
      message: "Full error",
      initialPrompt: "Recover me",
      context: { environment: "Environment" },
      timestamp: expect.any(Date),
    });
  });

  test("legacy callers clear previous context and prompt when neither is supplied", () => {
    const store = useErrorDialogStore.getState();
    store.showError("Start failed", "First error", "Recover me", {
      project: "Project",
      environment: "Environment",
    });

    store.showError("Generic error", "Second error");

    const error = useErrorDialogStore.getState().error;
    expect(error).toEqual({
      title: "Generic error",
      message: "Second error",
      timestamp: expect.any(Date),
      initialPrompt: undefined,
      context: undefined,
    });
    expect(formatErrorContext(error?.context)).toBe("");
  });

  test("accepts explicit empty context and closes the dialog", () => {
    useErrorDialogStore.getState().showError("Error", "Details", undefined, {});

    expect(useErrorDialogStore.getState().error?.context).toEqual({});
    expect(formatErrorContext(useErrorDialogStore.getState().error?.context)).toBe("");

    useErrorDialogStore.getState().closeError();
    expect(useErrorDialogStore.getState().error).toBeNull();
  });
});
