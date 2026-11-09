import { expect, test, spyOn } from "bun:test";
import { containerCredentialMode, containerOpenCodeMode } from "./container-credential-mode.js";
import type { CommandContext } from "./commands-context.js";
const context = {} as CommandContext;
test.each([
  ["supported", "supported", "launcher"],
  ["unsupported", "supported", "verifier"],
  ["unsupported", "unsupported", "token-file"],
] as const)("bridge-launch %s, bridge-credential %s: %s", async (launch, credential, mode) => {
  const asked: string[] = [];
  expect(
    await containerCredentialMode(context, "container", async (_id, _context, capability) => {
      asked.push(capability);
      return capability === "bridge-launch" ? launch : credential;
    }),
  ).toBe(mode);
  // The launcher implies the verifier, so a launcher image is asked nothing more.
  expect(asked).toEqual(
    launch === "supported" ? ["bridge-launch"] : ["bridge-launch", "bridge-credential"],
  );
});
test("unknown and failed reads refuse a downgrade", async () => {
  const launcherUnknown = async (_id: string, _context: unknown, capability: string) =>
    capability === "bridge-launch" ? ("unknown" as const) : ("supported" as const);
  for (const check of [
    launcherUnknown,
    async () => "unknown" as const,
    async (): Promise<never> => {
      throw new Error("unavailable");
    },
  ]) {
    await expect(containerCredentialMode(context, "container", check)).rejects.toThrow(
      "Cannot determine bridge credential support",
    );
  }
});

test.each(["supported", "legacy", "unavailable"] as const)(
  "unrecorded container inspects its image: %s",
  async (kind) => {
    const { containerImageCapabilitySupport } = await import("./claude-state-signal.js");
    const inspected: string[] = [];
    const manifests: string[] = [];
    const unrecorded = {
      storage: { loadEnvironments: async () => [] },
    } as unknown as CommandContext;
    const support = await containerImageCapabilitySupport(
      "old-container",
      unrecorded,
      "bridge-credential",
      1,
      async (imageId) => {
        manifests.push(imageId);
        if (kind === "unavailable") return { kind: "unavailable" };
        if (kind === "legacy") return { kind: "legacy" };
        return {
          kind: "manifest",
          manifest: {
            schemaVersion: 1,
            appVersion: "test",
            sourceRevision: null,
            architecture: "amd64",
            runtimes: {},
            agents: {},
            bridges: [],
            stateFormats: {},
            capabilities: { "bridge-credential": 1 },
          },
        };
      },
      async (id) => {
        inspected.push(id);
        return "sha256:actual-image";
      },
    );
    expect(inspected).toEqual(["old-container"]);
    expect(manifests).toEqual(["sha256:actual-image"]);
    if (kind === "unavailable") {
      await expect(
        containerCredentialMode(unrecorded, "old-container", async () => support),
      ).rejects.toThrow("Cannot determine");
    } else {
      expect(await containerCredentialMode(unrecorded, "old-container", async () => support)).toBe(
        kind === "supported" ? "launcher" : "token-file",
      );
    }
  },
);

test("unrecorded runtime uses Docker inspect stdout and refuses inspect errors", async () => {
  const shell = await import("./shell.js");
  const { containerImageCapabilitySupport } = await import("./claude-state-signal.js");
  const context = { storage: { loadEnvironments: async () => [] } } as unknown as CommandContext;
  const inspect = spyOn(shell, "runCommand").mockResolvedValue({
    stdout: "sha256:actual-image\n",
    stderr: "",
  });
  const images: string[] = [];
  try {
    expect(
      await containerImageCapabilitySupport(
        "old-container",
        context,
        "bridge-credential",
        1,
        async (image) => {
          images.push(image);
          return { kind: "legacy" };
        },
      ),
    ).toBe("unsupported");
    expect(images).toEqual(["sha256:actual-image"]);
    expect(inspect).toHaveBeenCalledWith("docker", [
      "inspect",
      "--format",
      "{{.Image}}",
      "old-container",
    ]);
    inspect.mockRejectedValue(new Error("daemon unavailable"));
    expect(
      await containerImageCapabilitySupport("old-container", context, "bridge-credential", 1),
    ).toBe("unknown");
  } finally {
    inspect.mockRestore();
  }
});

test.each([
  ["supported", "supported", "opencode-launcher"],
  ["unsupported", "supported", "launcher"],
  ["unsupported", "unsupported", "verifier"],
] as const)(
  "OpenCode with opencode-launch %s and bridge-launch %s starts as %s",
  async (openCodeLaunch, bridgeLaunch, mode) => {
    const asked: string[] = [];
    expect(
      await containerOpenCodeMode(context, "container", async (_id, _context, capability) => {
        asked.push(capability);
        if (capability === "opencode-launch") return openCodeLaunch;
        if (capability === "bridge-launch") return bridgeLaunch;
        return "supported";
      }),
    ).toBe(mode);
    expect(asked[0]).toBe("opencode-launch");
  },
);

test("OpenCode refuses a downgrade when its launcher support cannot be read", async () => {
  await expect(
    containerOpenCodeMode(context, "container", async (_id, _context, capability) =>
      capability === "opencode-launch" ? "unknown" : "supported",
    ),
  ).rejects.toThrow("Cannot determine bridge credential support");
});
