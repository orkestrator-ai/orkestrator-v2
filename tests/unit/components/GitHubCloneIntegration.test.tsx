import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddProjectDialog } from "@/components/projects/AddProjectDialog";
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
  for (const destination of ["non-git", "other-origin", "matching-retry"] as const) {
    test(`handles a ${destination} destination through the real add_project handler`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-clone-integration-"));
      const storage = new StorageService(path.join(root, "data"));
      const localPath = path.join(root, "destination");
      await storage.init();
      await fs.mkdir(localPath);
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
      const commands = createCommandRegistry({
        projectCreation: {
          runCommand: async (command, args = [], options) => {
            if (command !== "gh") return runCommand(command, args, options);
            const stdout = args.includes("user")
              ? "octocat_acme"
              : args[0] === "config"
                ? "https"
                : args[0] === "repo"
                  ? JSON.stringify([
                      {
                        name: "api",
                        nameWithOwner: "acme/api",
                        url: "https://github.com/acme/api",
                        sshUrl: "git@github.com:acme/api.git",
                      },
                    ])
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
        fireEvent.click(screen.getByRole("button", { name: /^api/ }));
        fireEvent.change(screen.getByLabelText(/Local path/), { target: { value: localPath } });
        fireEvent.click(screen.getByRole("button", { name: "Clone project" }));
        if (destination === "matching-retry") {
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
        expect(await fs.readFile(path.join(localPath, "keep.txt"), "utf8")).toBe("preserved");
      } finally {
        cleanup();
        transport.mockRestore();
        useProjectStore.setState({ projects: [], isLoading: false, error: null });
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
