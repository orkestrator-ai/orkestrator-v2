import { describe, expect, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const {
  CommandFailedError,
  GitRemoteTimeoutError,
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  commandTesting,
} = await createCommandFixtures();

describe("Electron backend command registry", () => {
  // The `security` stub only takes effect on darwin, where `getHostClaudeCredentials`
  // consults the Keychain; elsewhere resolution starts at the on-disk credential.
  // Seeding both with the same payload keeps these tests asserting the same thing
  // on every platform instead of silently depending on the developer's OS.

  test("classifies each lifecycle failure category from its structured outcome", () => {
    const classify = commandTesting.environmentLifecycleErrorMessage;

    // `execFile` SIGTERMs a timed-out child, so stdout/stderr are empty and the
    // message is the generic "Command failed: <argv>". The outcome flag is the
    // only place the timeout is visible.
    expect(
      classify(
        new CommandFailedError("Command failed: docker start abc", {
          timedOut: true,
        }),
      ),
    ).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.timedOut);
    expect(
      classify(
        new CommandFailedError("spawn docker ENOENT", {
          executableMissing: true,
        }),
      ),
    ).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable);

    // Real Docker CLI strings, not paraphrases of them.
    expect(
      classify(
        new Error(
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        ),
      ),
    ).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable);
    expect(
      classify(
        new Error(
          "Unable to find image 'orkestrator-v2:latest' locally\ndocker: Error response from daemon: pull access denied",
        ),
      ),
    ).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageUnavailable);
    expect(classify(new Error("docker: Error response from daemon: manifest unknown"))).toBe(
      ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageUnavailable,
    );
    expect(
      classify(
        new Error("failed to register layer: write /var/lib/docker/x: no space left on device"),
      ),
    ).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.diskFull);
    expect(
      classify(
        new Error(
          "ssh_askpass: exec(/usr/lib/ssh/ssh-askpass): No such file or directory\ngit@github.com: Permission denied (publickey).",
        ),
      ),
    ).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitSshAuthentication);

    // A blocked SSH port: the cause is in the output, and it is not a key
    // problem even though Git adds "Could not read from remote repository".
    const sshUnreachable =
      "Couldn't reach the git remote over SSH (github.com, port 22). Your network may be blocking SSH.";
    expect(
      classify(
        new CommandFailedError(
          "ssh: connect to host github.com port 22: Operation timed out\r\nfatal: Could not read from remote repository.",
          {
            stderr:
              "ssh: connect to host github.com port 22: Operation timed out\r\nfatal: Could not read from remote repository.",
            exitCode: 128,
          },
        ),
      ),
    ).toStartWith(sshUnreachable);
    expect(
      classify(
        new Error("worktree failed", {
          cause: new CommandFailedError("Command failed: git fetch origin main", {
            stderr: "ssh: connect to host github.com port 22: Connection timed out",
            exitCode: 128,
          }),
        }),
      ),
    ).toStartWith(sshUnreachable);
    expect(
      classify(new Error("ssh: connect to host /home/me/secret port 22: Operation timed out")),
    ).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown);

    // A remote fetch that hangs (e.g. ssh waiting on a passphrase) is a
    // timeout too, but pointing at the container runtime would be wrong.
    expect(classify(new GitRemoteTimeoutError("Command failed: git fetch origin main"))).toBe(
      ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitRemoteTimedOut,
    );
    expect(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitRemoteTimedOut).not.toMatch(/container/i);

    expect(classify(new Error("Project has no local path - cannot create a local worktree"))).toBe(
      ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.noLocalPath,
    );
    expect(classify(new Error("Setup script failed"))).toBe(
      ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript,
    );

    // Anything unrecognized collapses to the fallback rather than leaking the
    // child's own text into a persisted, rendered field.
    expect(classify(new Error("fatal: could not read Username for 'https://github.com'"))).toBe(
      ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown,
    );
    expect(classify("a bare string")).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown);
    expect(classify(undefined)).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown);

    // Every reachable value is one of the fixed constants.
    expect(classify(new Error("anything at all"))).toBeOneOf(
      Object.values(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES),
    );
  });
});
