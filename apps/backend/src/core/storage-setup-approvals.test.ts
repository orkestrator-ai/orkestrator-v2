import { expect, test } from "bun:test";

import { MAX_SETUP_APPROVALS_PER_PROJECT } from "./storage-setup-approvals.js";
import { withTemporaryStorage } from "./storage-test-support.js";

const hash = (n: number) => n.toString(16).padStart(64, "0");

test("approvals are per project, bounded, and removed with the project", async () => {
  await withTemporaryStorage(async (storage) => {
    const project = await storage.addProject({
      id: "project-a",
      name: "A",
      gitUrl: "https://github.com/acme/a.git",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
    expect(storage.setupApprovals.isSetupCommandsApproved(project.id, hash(1))).toBe(false);
    storage.setupApprovals.approveSetupCommands(project.id, hash(1));
    expect(storage.setupApprovals.isSetupCommandsApproved(project.id, hash(1))).toBe(true);
    expect(storage.setupApprovals.isSetupCommandsApproved("project-b", hash(1))).toBe(false);

    // The oldest approval goes once the bound is reached.
    for (let n = 2; n <= MAX_SETUP_APPROVALS_PER_PROJECT + 1; n += 1) {
      storage.setupApprovals.approveSetupCommands(project.id, hash(n));
    }
    expect(storage.setupApprovals.isSetupCommandsApproved(project.id, hash(1))).toBe(false);
    expect(storage.setupApprovals.isSetupCommandsApproved(project.id, hash(2))).toBe(true);

    expect(() => storage.setupApprovals.approveSetupCommands(project.id, "not-a-hash")).toThrow(
      "Invalid setup commands hash",
    );

    await storage.removeProject(project.id);
    expect(storage.setupApprovals.isSetupCommandsApproved(project.id, hash(2))).toBe(false);
  });
});
