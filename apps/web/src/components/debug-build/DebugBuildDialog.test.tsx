import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { CreateDebugBuildInput } from "@orkestrator/protocol/debug-build";
import * as buildPipelines from "@/lib/backend/build-pipelines";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { useDebugBuildStore } from "@/stores/debugBuildStore";
import { DebugBuildDialogHost } from "./DebugBuildDialog";

const target = { nodeId: null, projectId: "project-1", environmentId: "env-1" };

function openDialog(capture: { screenshot: string | null; captureError: string | null }) {
  useDebugBuildStore.getState().beginCapture(target);
  useDebugBuildStore.getState().showDialog(capture);
}

let sent: CreateDebugBuildInput[] = [];
beforeEach(() => {
  sent = [];
});

afterEach(() => {
  cleanup();
  mock.restore();
  useDebugBuildStore.getState().close();
});

function stubCreate(outcomes: Array<"ok" | Error>) {
  return spyOn(buildPipelines, "createDebugBuild").mockImplementation(async (input) => {
    sent.push(input);
    const outcome = outcomes.shift() ?? "ok";
    if (outcome instanceof Error) throw outcome;
    return { taskId: "task-1", pipelineId: "pipeline-1", projectId: "project-1" };
  });
}

test("renders nothing until the button opens it", () => {
  renderInAppCommandScope(<DebugBuildDialogHost />);
  expect(screen.queryByTestId("debug-build-dialog") === null).toBe(true);
});

test("shows the capture, requires the problem, and sends the text, screenshot and environment", async () => {
  stubCreate(["ok"]);
  openDialog({ screenshot: "AAAA", captureError: null });
  renderInAppCommandScope(<DebugBuildDialogHost />);

  const image = screen.getByTestId("debug-build-screenshot") as HTMLImageElement;
  expect(image.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  const include = screen.getByRole("checkbox", { name: "Attach this screenshot" });
  expect(include.getAttribute("aria-checked")).toBe("true");

  const submit = screen.getByRole("button", { name: "Create pipeline environment" });
  expect(submit.hasAttribute("disabled")).toBe(true);

  fireEvent.change(screen.getByLabelText(/Problem \/ objective/), {
    target: { value: "  The dialog does not open  " },
  });
  fireEvent.change(screen.getByLabelText(/Expected result/), {
    target: { value: "It opens" },
  });
  expect(submit.hasAttribute("disabled")).toBe(false);
  await act(async () => {
    fireEvent.click(submit);
  });

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({
    environmentId: "env-1",
    problem: "The dialog does not open",
    expectedResult: "It opens",
    screenshot: "AAAA",
  });
  expect(sent[0]!.requestId.length).toBeGreaterThan(0);
  await waitFor(() => expect(useDebugBuildStore.getState().open).toBe(false));
});

test("an unticked screenshot and a blank expected result are left out", async () => {
  stubCreate(["ok"]);
  openDialog({ screenshot: "AAAA", captureError: null });
  renderInAppCommandScope(<DebugBuildDialogHost />);

  fireEvent.click(screen.getByRole("checkbox", { name: "Attach this screenshot" }));
  fireEvent.change(screen.getByLabelText(/Problem \/ objective/), {
    target: { value: "Add an export button" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create pipeline environment" }));
  });
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.screenshot).toBeUndefined();
  expect(sent[0]!.expectedResult).toBeUndefined();
});

test("says why there is no screenshot when the capture was not possible", () => {
  openDialog({ screenshot: null, captureError: "This client cannot capture its window." });
  renderInAppCommandScope(<DebugBuildDialogHost />);
  expect(screen.getByText("This client cannot capture its window.")).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: "Attach this screenshot" }) === null).toBe(true);
});

test("a failed create keeps the dialog open, and retrying the same request reuses its key", async () => {
  stubCreate([new Error("Build pipeline supervisor is unavailable"), "ok"]);
  openDialog({ screenshot: null, captureError: null });
  renderInAppCommandScope(<DebugBuildDialogHost />);
  fireEvent.change(screen.getByLabelText(/Problem \/ objective/), {
    target: { value: "Crash on reload" },
  });
  const submit = screen.getByRole("button", { name: "Create pipeline environment" });
  await act(async () => {
    fireEvent.click(submit);
  });
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(useDebugBuildStore.getState().open).toBe(true);
  await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));

  await act(async () => {
    fireEvent.click(submit);
  });
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]!.requestId).toBe(sent[0]!.requestId);
});

test("an edited request after a failure gets a new key", async () => {
  stubCreate([new Error("offline"), "ok"]);
  openDialog({ screenshot: null, captureError: null });
  renderInAppCommandScope(<DebugBuildDialogHost />);
  const problem = screen.getByLabelText(/Problem \/ objective/);
  fireEvent.change(problem, { target: { value: "First wording" } });
  const submit = screen.getByRole("button", { name: "Create pipeline environment" });
  await act(async () => {
    fireEvent.click(submit);
  });
  await waitFor(() => expect(sent).toHaveLength(1));
  await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  fireEvent.change(problem, { target: { value: "Second wording" } });
  await act(async () => {
    fireEvent.click(submit);
  });
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
});

test("after an edit, an unchanged retry reuses the edited request's key", async () => {
  stubCreate([new Error("offline"), new Error("offline"), "ok"]);
  openDialog({ screenshot: null, captureError: null });
  renderInAppCommandScope(<DebugBuildDialogHost />);
  const problem = screen.getByLabelText(/Problem \/ objective/);
  const submit = screen.getByRole("button", { name: "Create pipeline environment" });
  const send = async (count: number, fails = true) => {
    await act(async () => {
      fireEvent.click(submit);
    });
    await waitFor(() => expect(sent).toHaveLength(count));
    if (fails) await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  };
  fireEvent.change(problem, { target: { value: "First wording" } });
  await send(1);
  fireEvent.change(problem, { target: { value: "Second wording" } });
  await send(2);
  // The answer to the edited request was lost; the same edited request retries.
  await send(3, false);
  expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
  expect(sent[2]!.requestId).toBe(sent[1]!.requestId);
  expect(sent[2]!.problem).toBe("Second wording");
});
