import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { AUTO_EXPAND_FILE_LIMIT, PullRequestCodeTab } from "./PullRequestCodeTab";
import {
  callsFor,
  deferred,
  installBackend,
  makeFile,
  makeFiles,
  prRef,
  resetBackend,
  resetPullRequestsStore,
} from "./pull-request-test-fixtures";

const key = "acme/widget#42";

function ConnectedCodeTab() {
  const files = usePullRequestsStore((state) => state.files.get(key));
  return files ? <PullRequestCodeTab pullRequest={prRef} files={files} canComment /> : null;
}

beforeEach(() => {
  resetPullRequestsStore();
});

afterEach(() => {
  cleanup();
  resetBackend();
});

describe("PullRequestCodeTab", () => {
  test("viewed checkbox is optimistic, collapses the file and reverts on failure", async () => {
    usePullRequestsStore.setState({ files: new Map([[key, makeFiles()]]) });
    const pending = deferred<never>();
    installBackend({ set_github_pull_request_file_viewed: () => pending.promise });
    render(<ConnectedCodeTab />);

    expect(screen.getByTestId("pull-request-diff")).toBeTruthy();
    const checkbox = screen.getByRole("checkbox", { name: "Viewed src/app.ts" });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("viewed-count").textContent).toBe("1 / 1 viewed");
    expect(screen.queryByTestId("pull-request-diff") === null).toBe(true);
    expect(callsFor("set_github_pull_request_file_viewed")).toEqual([
      { owner: "acme", repo: "widget", number: 42, path: "src/app.ts", viewed: true },
    ]);

    await act(async () => {
      pending.reject(new Error("GitHub said no"));
      await pending.promise.catch(() => undefined);
    });
    await waitFor(() => expect(checkbox.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByTestId("viewed-count").textContent).toBe("0 / 1 viewed");
    expect(mockToastError).toHaveBeenCalledWith("GitHub said no");
  });

  test("files without a patch link to GitHub instead of a diff", () => {
    usePullRequestsStore.setState({
      files: new Map([
        [key, makeFiles({ files: [makeFile({ patchAvailable: false, hunks: [] })] })],
      ]),
    });
    render(<ConnectedCodeTab />);
    expect(screen.getByText(/Diff not available here/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /View on GitHub/ })).toBeTruthy();
  });

  test("large pull requests start with every file collapsed", () => {
    const many = Array.from({ length: AUTO_EXPAND_FILE_LIMIT + 1 }, (_, index) =>
      makeFile({ path: `src/file-${index}.ts` }),
    );
    usePullRequestsStore.setState({ files: new Map([[key, makeFiles({ files: many })]]) });
    render(<ConnectedCodeTab />);
    expect(screen.queryByTestId("pull-request-diff") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand all files" }));
    expect(screen.getAllByTestId("pull-request-diff")).toHaveLength(many.length);
  });
});
