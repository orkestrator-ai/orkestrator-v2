import { expect, mock, test } from "bun:test";
import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import { ProjectGitService } from "./project-git-service.js";
import type { StorageService } from "./storage.js";

for (const fails of [false, true]) {
  test(`user sync and turn admission wait for background sync (failure=${fails})`, async () => {
    const git = new ProjectGitService({} as StorageService);
    let finish!: () => void;
    const status = { projectId: "project" } as ProjectGitStatus;
    const running = new Promise<ProjectGitStatus>((resolve, reject) => {
      finish = () => (fails ? reject(new Error("offline")) : resolve(status));
    });
    // Isolate Git execution while exercising the service's actual coordination.
    const execute = mock(() => running);
    (git as unknown as { syncOnce: typeof execute }).syncOnce = execute;
    const background = git.syncAfterMerge("project");
    const observed = background.catch(() => undefined);
    let admitted = false;
    const turn = git.beginTurnAfterMergeSync("project").then((release) => {
      admitted = true;
      release();
    });
    let synced = false;
    execute.mockImplementationOnce(() => running);
    const user = git
      .sync("project")
      .then(() => {
        synced = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(synced).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([observed, turn, user]);
    expect(admitted).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
}
