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

  test("deduplicates an unchanged failure until Docker recovers", async () => {
    const logWarning = mock((_message: string) => undefined);
    let available = false;
    const dependencies = {
      commandExists: async () => true,
      runCommand: async () => {
        if (!available) {
          throw new CommandFailedError("Cannot connect to the Docker daemon", { exitCode: 1 });
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      logWarning,
    };

    await checkDockerAvailability(dependencies);
    await checkDockerAvailability(dependencies);
    await checkDockerAvailability(dependencies);
    expect(logWarning).toHaveBeenCalledTimes(1);

    available = true;
    await expect(checkDockerAvailability(dependencies)).resolves.toEqual({
      available: true,
      reason: null,
    });
    available = false;
    await checkDockerAvailability(dependencies);
    expect(logWarning).toHaveBeenCalledTimes(2);
  });

  test("logs through console.warn when no warning dependency is supplied", async () => {
    const originalConsoleWarn = console.warn;
    const consoleWarn = mock((_message: string) => undefined);
    console.warn = consoleWarn;

    try {
      await checkDockerAvailability({ commandExists: async () => false });
      expect(consoleWarn).toHaveBeenCalledWith(
        "[Docker] Availability probe failed: reason=not-installed commandExists=false",
      );
    } finally {
      console.warn = originalConsoleWarn;
    }
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
