import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddProjectDialog } from "@/components/projects/AddProjectDialog";
import { mockToastError, mockToastSuccess } from "../../mocks/sonner";
import { useProjects } from "@/hooks/useProjects";
import { useProjectStore } from "@/stores/projectStore";
import * as native from "@/lib/native/backend";
import {
  createCommandRegistry,
  type CommandContext,
} from "../../../apps/backend/src/core/commands";
import { EnvironmentLifecycleTaskTracker } from "../../../apps/backend/src/core/environment-lifecycle-tasks";
import { runCommand } from "../../../apps/backend/src/core/shell";
import { StorageService } from "../../../apps/backend/src/core/storage";

jest.setTimeout(30_000);
afterEach(cleanup);

function CloneDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const projects = useProjects();
  return (
    <AddProjectDialog
      open
      onOpenChange={onOpenChange}
      onAdd={async (url, localPath, cloneOnly) => {
        await projects.addProject(url, localPath, cloneOnly);
      }}
      onCreate={async (localPath) => {
        await projects.createProjectFromScratch(localPath);
      }}
      validateGitUrl={projects.validateGitUrl}
    />
  );
}

// Keep the picker, hook, web command wrapper, registry, filesystem and Git real.
// Only the native transport and credentialed gh listing are replaced.
describe("GitHub picker to project registration", () => {
  for (const destination of [
    "non-git",
    "other-origin",
    "matching-retry",
    "missing",
    "empty",
  ] as const) {
    test(`handles a ${destination} destination through the real add_project handler`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-clone-integration-"));
      const storage = new StorageService(path.join(root, "data"));
      const localPath = path.join(root, "destination");
      await storage.init();
      const willClone = destination === "missing" || destination === "empty";
      const source = path.join(root, "source");
      if (willClone) {
        await fs.mkdir(source);
        await runCommand("git", ["-C", source, "init", "-b", "main"]);
        await fs.writeFile(path.join(source, "README.md"), "cloned content");
        await runCommand("git", ["-C", source, "add", "."]);
        await runCommand("git", [
          "-C",
          source,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "Initial",
        ]);
      }
      if (destination !== "missing") await fs.mkdir(localPath);
      if (!willClone) {
        await fs.writeFile(path.join(localPath, "keep.txt"), "preserved");
        if (destination !== "non-git") {
          await runCommand("git", ["-C", localPath, "init", "-b", "main"]);
          await runCommand("git", [
            "-C",
            localPath,
            "remote",
            "add",
            "origin",
            destination === "matching-retry"
              ? "git@github.com:acme/api.git"
              : "https://github.com/acme/other.git",
          ]);
        }
      }
      // The missing-destination case finds api on page eleven of a 1,001-repo organization.
      const ghRepositories = Array.from(
        { length: destination === "missing" ? 1001 : 1 },
        (_, index) => {
          const name = destination !== "missing" || index === 1000 ? "api" : `repo-${index}`;
          return {
            name,
            nameWithOwner: `acme/${name}`,
            url: `https://github.com/acme/${name}`,
            sshUrl: `git@github.com:acme/${name}.git`,
          };
        },
      );
      const commands = createCommandRegistry({
        projectCreation: {
          runCommand: async (command, args = [], options) => {
            // Redirect only the network clone to a local Git fixture; cloning and registration stay real.
            if (command === "git" && args.includes("clone") && willClone) {
              const redirected = args.map((arg) =>
                arg === "https://github.com/acme/api.git" ? source : arg,
              );
              const result = await runCommand(command, redirected, options);
              await runCommand("git", [
                "-C",
                options?.cwd ?? localPath,
                "remote",
                "set-url",
                "origin",
                "https://github.com/acme/api.git",
              ]);
              return result;
            }
            if (command !== "gh") return runCommand(command, args, options);
            const offset = Number(args.find((arg) => arg.startsWith("endCursor="))?.slice(10) ?? 0);
            const next = offset + 100;
            const stdout = args.includes("user")
              ? "octocat_acme"
              : args[0] === "config"
                ? "https"
                : args.includes("graphql")
                  ? JSON.stringify({
                      data: {
                        repositoryOwner: {
                          repositories: {
                            nodes: ghRepositories.slice(offset, next),
                            pageInfo: {
                              hasNextPage: next < ghRepositories.length,
                              endCursor: next < ghRepositories.length ? String(next) : null,
                            },
                          },
                        },
                      },
                    })
                  : "acme";
            return { stdout, stderr: "" };
          },
        },
      });
      const context = {
        storage,
        appRoot: "",
        resourceRoot: "",
        emit: () => undefined,
        environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
      } as CommandContext;
      const transport = spyOn(native, "invoke").mockImplementation(async (name, args) => {
        const handler = commands.get(name);
        if (!handler) throw new Error(`Unexpected command: ${name}`);
        return (await handler(args ?? {}, context)) as never;
      });
      const changes: boolean[] = [];
      useProjectStore.setState({ projects: [], isLoading: false, error: null });
      try {
        render(<CloneDialog onOpenChange={(open) => changes.push(open)} />);
        fireEvent.click(screen.getByRole("button", { name: "From GitHub" }));
        await screen.findByRole("list", { name: "organizations" });
        fireEvent.click(screen.getByRole("button", { name: /^acme/ }));
        await screen.findByRole("list", { name: "repositories" });
        if (destination === "missing") {
          fireEvent.change(screen.getByLabelText("Search repositories"), {
            target: { value: "api" },
          });
          for (let page = 1; page <= 10; page++) {
            fireEvent.click(screen.getByRole("button", { name: "Load more repositories" }));
            if (page < 10) await screen.findByRole("button", { name: "Load more repositories" });
            else await screen.findByRole("button", { name: /^api/ });
          }
        }
        fireEvent.click(screen.getByRole("button", { name: /^api/ }));
        fireEvent.change(screen.getByLabelText(/Local path/), { target: { value: localPath } });
        fireEvent.click(screen.getByRole("button", { name: "Clone project" }));
        if (destination === "matching-retry" || willClone) {
          await waitFor(() => expect(changes).toEqual([false]));
          expect(await storage.loadProjects()).toHaveLength(1);
          expect(useProjectStore.getState().projects[0]?.localPath).toBe(localPath);
        } else {
          expect((await screen.findByRole("alert")).textContent).toContain(
            "Clone destination is not empty",
          );
          expect(changes).toEqual([]);
          expect(await storage.loadProjects()).toEqual([]);
          expect(useProjectStore.getState().projects).toEqual([]);
        }
        expect(transport).toHaveBeenCalledWith("add_project", {
          gitUrl: "https://github.com/acme/api.git",
          localPath,
          cloneOnly: true,
        });
        expect(
          await fs.readFile(path.join(localPath, willClone ? "README.md" : "keep.txt"), "utf8"),
        ).toBe(willClone ? "cloned content" : "preserved");
        if (willClone)
          expect(
            (
              await runCommand("git", ["-C", localPath, "rev-parse", "--show-toplevel"])
            ).stdout.trim(),
          ).toBe(await fs.realpath(localPath));
      } finally {
        cleanup();
        transport.mockRestore();
        useProjectStore.setState({ projects: [], isLoading: false, error: null });
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

for (const outcome of ["success", "error"] as const) {
  test(`emits exactly one ${outcome} toast through useProjects after dialog unmount`, async () => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const transport = spyOn(native, "invoke").mockImplementation(async (name) => {
      if (name === "get_projects") return [] as never;
      if (name === "list_github_clone_accounts")
        return [{ login: "acme", kind: "organization" }] as never;
      if (name === "list_github_clone_repositories")
        return {
          repositories: [
            {
              name: "api",
              fullName: "acme/api",
              cloneUrl: "https://github.com/acme/api.git",
              description: null,
              updatedAt: null,
            },
          ],
          truncated: false,
        } as never;
      if (name === "add_project") return (await pending) as never;
      throw new Error(`Unexpected command: ${name}`);
    });
    // The preload replaces sonner with these shared spies and clears them
    // before every test, so they count only this test's toasts.
    const success = mockToastSuccess;
    const error = mockToastError;
    useProjectStore.setState({ projects: [], isLoading: false, error: null });
    try {
      const view = render(<CloneDialog onOpenChange={() => undefined} />);
      fireEvent.click(screen.getByRole("button", { name: "From GitHub" }));
      fireEvent.click(await screen.findByRole("button", { name: /^acme/ }));
      fireEvent.click(await screen.findByRole("button", { name: /^api/ }));
      fireEvent.change(screen.getByLabelText(/Local path/), { target: { value: "/tmp/api" } });
      fireEvent.click(screen.getByRole("button", { name: "Clone project" }));
      await waitFor(() =>
        expect(transport.mock.calls.some(([name]) => name === "add_project")).toBe(true),
      );
      view.unmount();
      await act(async () => {
        if (outcome === "success")
          resolve({
            id: "clone",
            name: "api",
            gitUrl: "https://github.com/acme/api.git",
            localPath: "/tmp/api",
          });
        else reject(new Error("clone failed"));
      });
      expect(success).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      expect(error).toHaveBeenCalledTimes(outcome === "error" ? 1 : 0);
    } finally {
      cleanup();
      transport.mockRestore();
      useProjectStore.setState({ projects: [], isLoading: false, error: null });
    }
  });
}
