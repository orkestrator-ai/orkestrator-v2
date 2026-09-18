import { describe, expect, mock, test } from "bun:test";
import { CommandFailedError } from "./shell.js";
import { checkDockerAvailability, dockerUnavailableReason } from "./commands-registry-docker.js";

describe("Docker availability classification", () => {
  test("reports a missing Docker command", async () => {
    const logWarning = mock((_message: string) => undefined);
    await expect(
      checkDockerAvailability({ commandExists: async () => false, logWarning }),
    ).resolves.toEqual({ available: false, reason: "not-installed" });
    expect(logWarning).toHaveBeenCalledWith(
      "[Docker] Availability probe failed: reason=not-installed commandExists=false",
    );
  });

  test("uses structured timeout metadata instead of error text", async () => {
    const logWarning = mock((_message: string) => undefined);
    await expect(
      checkDockerAvailability({
        commandExists: async () => true,
        runCommand: async () => {
          throw new CommandFailedError("Command failed: docker info", { timedOut: true });
        },
        logWarning,
      }),
    ).resolves.toEqual({ available: false, reason: "timed-out" });
    expect(logWarning).toHaveBeenCalledTimes(1);
    expect(logWarning.mock.calls[0]?.[0]).toContain(
      "reason=timed-out commandExists=true errorType=CommandFailedError timedOut=true",
    );
  });

  test("logs bounded metadata without copying Docker stderr", async () => {
    const logWarning = mock((_message: string) => undefined);
    await checkDockerAvailability({
      commandExists: async () => true,
      runCommand: async () => {
        throw new CommandFailedError(
          "Cannot connect to the Docker daemon at tcp://person:super-secret@example.invalid:2376",
          { exitCode: 1 },
        );
      },
      logWarning,
    });

    expect(logWarning).toHaveBeenCalledTimes(1);
    const diagnostic = logWarning.mock.calls[0]?.[0] ?? "";
    expect(diagnostic).toContain("reason=daemon-unavailable");
    expect(diagnostic).toContain("exitCode=1");
    expect(diagnostic).not.toContain("super-secret");
    expect(diagnostic).not.toContain("example.invalid");
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
