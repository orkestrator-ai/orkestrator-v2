import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { projectStore, type ProjectState } from "@/stores/projectStore";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import type { Project } from "@/types";
import { ProjectCheckoutNotice } from "./ProjectCheckoutNotice";
import { useProjectCheckout } from "./useProjectCheckout";

const LEAF = "bk_leaf" as BackendId;
const COMMAND = "bk_command" as BackendId;

afterEach(() => {
  cleanup();
  cleanupNodeScopes();
});

/** What the coordinator panel renders for a checkout, without the panel. */
function CheckoutHarness({ projectId }: { projectId: string }) {
  const checkout = useProjectCheckout(projectId);
  return checkout === "ready" ? (
    <p>Checkout ready</p>
  ) : (
    <ProjectCheckoutNotice projectId={projectId} state={checkout} />
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const leafProject = { id: "project-leaf", name: "repo", localPath: "/leaf/repo" } as Project;

/** A leaf node next to a command node, with the leaf's project list unread and failed. */
function renderUnavailableOnLeaf(getProjects: () => Promise<Project[]>) {
  const command = new FakeNodeClient({ nodeId: COMMAND, invoke: { get_projects: [] } });
  const commandView = renderInNodeScope(<></>, { client: command });
  const leaf = new FakeNodeClient({ nodeId: LEAF, invoke: { get_projects: getProjects } });
  const view = renderInNodeScope(<></>, {
    role: "leaf",
    client: leaf,
    windowScope: commandView.windowScope,
  });
  view.scope
    .store(projectStore)
    .setState({ projects: [], hasLoaded: false, isLoading: false, error: "offline" });
  view.rerender(<CheckoutHarness projectId="project-leaf" />);
  return { view, leaf, command };
}

describe("ProjectCheckoutNotice", () => {
  test("a failed project-list read shows the error and reloads that node's projects", async () => {
    const reads = [deferred<Project[]>()];
    const { view, leaf, command } = renderUnavailableOnLeaf(() => reads[0]!.promise);

    expect(screen.getByText("Could not load this machine's projects")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("offline");
    // An unread list is not evidence of absence.
    expect(screen.queryByText("Project not found on this machine") === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Repository settings" }) === null).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload projects" }));
    });
    expect(leaf.calls("get_projects")).toHaveLength(1);
    expect(command.calls("get_projects")).toHaveLength(0);
    // The leaf's own store is reading; the notice is busy until it answers.
    expect(view.scope.store(projectStore).getState().isLoading).toBe(true);

    await act(async () => {
      reads[0]!.resolve([leafProject]);
      await reads[0]!.promise;
    });
    await waitFor(() => expect(screen.getByText("Checkout ready")).toBeTruthy());
    expect(view.scope.store(projectStore).getState().projects).toEqual([leafProject]);
  });

  test("a reload that fails again stays retryable and shows the new error", async () => {
    let attempt = 0;
    const second = deferred<Project[]>();
    const { leaf } = renderUnavailableOnLeaf(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error("still offline")) : second.promise;
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload projects" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("still offline"));
    const reload = screen.getByRole("button", { name: "Reload projects" });
    expect(reload.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(reload);
    });
    expect(leaf.calls("get_projects")).toHaveLength(2);
    // The read cleared the error: the node's list is loading again.
    expect(screen.getByRole("status").textContent).toContain("Loading project");
    await act(async () => {
      second.resolve([]);
      await second.promise;
    });
    // The list now answered without the project: it is missing, not unknown.
    await waitFor(() => expect(screen.getByText("Project not found on this machine")).toBeTruthy());

    // A reload of a read list keeps the notice and disables its button meanwhile.
    const third = deferred<Project[]>();
    leaf.respond("get_projects", () => third.promise);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload projects" }));
    });
    expect(screen.getByRole("button", { name: "Reloading…" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      third.resolve([]);
      await third.promise;
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reload projects" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(leaf.calls("get_projects")).toHaveLength(3);
  });
});

describe("useProjectCheckout", () => {
  function checkoutFor(state: Partial<ProjectState>) {
    const view = renderInNodeScope(<></>);
    view.scope.store(projectStore).setState(state);
    view.rerender(<CheckoutHarness projectId="project-1" />);
  }

  test("a whitespace-only local path is no checkout", () => {
    checkoutFor({
      projects: [{ id: "project-1", localPath: "   " } as Project],
      hasLoaded: true,
    });
    expect(screen.getByText("Connect a local checkout")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Repository settings" })).toBeTruthy();
  });

  test("a loaded list keeps answering missing after a later read fails", () => {
    checkoutFor({ projects: [], hasLoaded: true, isLoading: false, error: "offline" });
    expect(screen.getByText("Project not found on this machine")).toBeTruthy();
  });

  test("an unread list with no error is still loading", () => {
    checkoutFor({ projects: [], hasLoaded: false, isLoading: false, error: null });
    expect(screen.getByRole("status").textContent).toContain("Loading project");
  });
});
