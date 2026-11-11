import { describe, expect, test } from "bun:test";
import { operationFailureCode } from "./container-lifecycle-service.js";
import { dockerUnavailableReason } from "./commands-registry-docker.js";
import { isDockerDaemonUnreachable, isDockerPathNotFound } from "./docker-cli-errors.js";

const UNREACHABLE = [
  // Current CLIs.
  "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory",
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
  'error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": EOF',
  // An attached `docker run` whose daemon stopped (SIGTERM) or died (SIGKILL)
  // while it waited, as Engine 29.9.3 prints them.
  'time="2026-11-11T14:55:41Z" level=error msg="Error waiting for container: Canceled: grpc: the client connection is closing: context canceled"',
  'time="2026-11-11T14:55:57Z" level=error msg="error waiting for container: unexpected EOF"',
];

describe("docker CLI error wording", () => {
  test("every unreachable-daemon wording is one class everywhere it is read", () => {
    for (const message of UNREACHABLE) {
      expect(isDockerDaemonUnreachable(message)).toBe(true);
      expect(isDockerPathNotFound(message)).toBe(false);
      expect(operationFailureCode(new Error(message))).toBe("daemon-unavailable");
      expect(dockerUnavailableReason(new Error(message))).toBe("daemon-unavailable");
    }
  });

  test("only the daemon's own answer means a path is missing", () => {
    expect(
      isDockerPathNotFound(
        "Error response from daemon: Could not find the file /x in container abc",
      ),
    ).toBe(true);
    expect(isDockerPathNotFound("open /x: no such file or directory")).toBe(false);
    expect(isDockerDaemonUnreachable("Error response from daemon: No such container: abc")).toBe(
      false,
    );
    // A daemon that answered the wait is not an outage.
    expect(
      isDockerDaemonUnreachable(
        "Error waiting for container: Error response from daemon: No such container: abc",
      ),
    ).toBe(false);
    expect(operationFailureCode(new Error("something else"))).toBe("unknown");
  });
});
