import { describe, expect, spyOn, test } from "bun:test";
import type { NetworkAccessMode } from "../models.js";
import type { StorageService } from "../storage.js";
import { configureLogger, resetLogger, type LogOutput } from "@orkestrator/protocol/logger";
import { startBuilding, startInput, withService } from "./service-test-support.js";

/**
 * A build launcher opens on the network access last chosen for the project
 * (`lastBuildNetworkAccessMode`), which the backend records when it admits a
 * build that creates a container with an explicit choice.
 */

async function lastChoice(storage: StorageService): Promise<NetworkAccessMode | undefined> {
  return (await storage.loadOwnConfig()).repositories["project-1"]?.lastBuildNetworkAccessMode;
}

describe("build launch network preference", () => {
  test("a failed preference save logs a warning, preserves the old choice and still provisions", async () => {
    const outputs: LogOutput[] = [];
    configureLogger({
      sink: (output) => {
        outputs.push(output);
      },
    });
    try {
      await withService(
        async (service, storage) => {
          await storage.patchRepositoryConfig("project-1", { lastBuildNetworkAccessMode: "full" });
          const patch = storage.patchRepositoryConfig.bind(storage);
          const failingSave = spyOn(storage, "patchRepositoryConfig").mockImplementation(
            async (projectId, fields, ...rest) => {
              if (fields.lastBuildNetworkAccessMode)
                throw new Error("Preference storage unavailable");
              return patch(projectId, fields, ...rest);
            },
          );
          try {
            const { started } = await startBuilding(service, storage, {
              existingEnvironmentId: undefined,
              environmentType: "containerized",
              environmentOptions: { networkAccessMode: "restricted" },
            });
            expect(started.id).toBeTruthy();
            expect(await lastChoice(storage)).toBe("full");
            expect(
              outputs.some(
                (output) =>
                  output.method === "warn" &&
                  output.line.includes("network-preference.save-failed"),
              ),
            ).toBe(true);
          } finally {
            failingSave.mockRestore();
          }
        },
        { realKanban: true, environmentType: "containerized" },
      );
    } finally {
      resetLogger();
    }
  });

  test("a new container's explicit choice is recorded for the project", async () => {
    await withService(
      async (service, storage) => {
        await service.start(
          startInput({
            existingEnvironmentId: undefined,
            environmentType: "containerized",
            environmentOptions: { networkAccessMode: "restricted" },
          }),
        );
        expect(await lastChoice(storage)).toBe("restricted");

        await service.start(
          startInput({
            taskId: "task-second",
            existingEnvironmentId: undefined,
            environmentType: "containerized",
            environmentOptions: { networkAccessMode: "full" },
          }),
        );
        expect(await lastChoice(storage)).toBe("full");
      },
      { realKanban: true, environmentType: "containerized" },
    );
  });

  test("a launch that chose nothing, a local worktree or an existing environment records nothing", async () => {
    await withService(
      async (service, storage) => {
        // No choice: the backend's own default is not something the user selected.
        await service.start(
          startInput({
            taskId: "task-no-choice",
            existingEnvironmentId: undefined,
            environmentType: "containerized",
          }),
        );
        // A local worktree has no firewall to apply a mode to.
        await service.start(
          startInput({
            taskId: "task-local",
            existingEnvironmentId: undefined,
            environmentType: "local",
            environmentOptions: { networkAccessMode: "restricted" },
          }),
        );
        // An existing environment keeps the network it already has.
        await service.start(
          startInput({
            taskId: "task-existing",
            environmentType: "containerized",
            environmentOptions: { networkAccessMode: "restricted" },
          }),
        );
        expect(await lastChoice(storage)).toBeUndefined();
      },
      { realKanban: true, environmentType: "containerized" },
    );
  });
});
