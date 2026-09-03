import { describe, expect, test } from "bun:test";
import { CommandFailedError } from "./shell.js";
import { checkDockerAvailability, dockerUnavailableReason } from "./commands-registry-docker.js";

describe("Docker availability classification", () => {
  test("reports a missing Docker command", async () => {
    await expect(checkDockerAvailability({ commandExists: async () => false })).resolves.toEqual({
      available: false,
      reason: "not-installed",
    });
  });

  test("uses structured timeout metadata instead of error text", async () => {
    await expect(
      checkDockerAvailability({
        commandExists: async () => true,
        runCommand: async () => {
          throw new CommandFailedError("Command failed: docker info", { timedOut: true });
        },
      }),
    ).resolves.toEqual({ available: false, reason: "timed-out" });
  });

  test("distinguishes an unavailable daemon from unrelated permission failures", () => {
    expect(dockerUnavailableReason(new Error("Cannot connect to the Docker daemon"))).toBe(
      "daemon-unavailable",
    );
    expect(
      dockerUnavailableReason(new Error("open /private/docker/ca.pem: permission denied")),
    ).toBe("unknown");
    expect(dockerUnavailableReason(new Error("remote Docker API returned access denied"))).toBe(
      "unknown",
    );
    expect(
      dockerUnavailableReason(
        new Error(
          "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
        ),
      ),
    ).toBe("permission-denied");
  });
});
