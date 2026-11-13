import { describe, expect, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import { countRootSetupSteps, readProjectSetupRequirements } from "./project-setup-requirements.js";
import type { GitBlobReader } from "./setup-approval.js";

function blobs(byRef: Record<string, string>): GitBlobReader {
  return async (_projectPath, ref) => byRef[ref] ?? null;
}

function contextWith(
  project: { id: string; localPath?: string } | null,
  defaultBranch = "main",
): Pick<CommandContext, "storage"> {
  return {
    storage: {
      getProject: async () => project,
      getRepositoryConfig: async () => ({ defaultBranch }),
    },
  } as unknown as Pick<CommandContext, "storage">;
}

describe("counting root steps the way workspace-setup.sh does", () => {
  test("an array counts its entries that are neither null nor empty", () => {
    expect(countRootSetupSteps('{"root":["apt-get install x","",null,"echo hi"]}')).toBe(2);
    expect(countRootSetupSteps('{"root":[]}')).toBe(0);
  });

  test("a string is one step unless it is empty", () => {
    expect(countRootSetupSteps('{"root":"apt-get install x"}')).toBe(1);
    expect(countRootSetupSteps('{"root":""}')).toBe(0);
  });

  test("absent, null or false is none; any other value is one", () => {
    expect(countRootSetupSteps('{"setupContainer":["bun install"]}')).toBe(0);
    expect(countRootSetupSteps('{"root":null}')).toBe(0);
    expect(countRootSetupSteps('{"root":false}')).toBe(0);
    expect(countRootSetupSteps('{"root":true}')).toBe(1);
    expect(countRootSetupSteps('{"root":{"cmd":"x"}}')).toBe(1);
  });

  test("text that does not parse, or is not an object, names none", () => {
    expect(countRootSetupSteps("{not json")).toBe(0);
    expect(countRootSetupSteps('["root"]')).toBe(0);
    expect(countRootSetupSteps("null")).toBe(0);
  });
});

describe("a project's setup requirements", () => {
  test("reads the default branch's root steps from the checkout", async () => {
    const config = JSON.stringify({
      root: ["command -v mise || curl -fsSL https://mise.run | sh"],
      setupContainer: ["mise install"],
    });
    expect(
      await readProjectSetupRequirements(
        "p1",
        contextWith({ id: "p1", localPath: "/repo" }, "develop"),
        blobs({ "refs/remotes/origin/develop": config }),
      ),
    ).toEqual({ rootSteps: 1, aptPackages: { packages: [], refused: [], invalid: false } });
  });

  test("a branch without the file has no root steps", async () => {
    expect(
      await readProjectSetupRequirements(
        "p1",
        contextWith({ id: "p1", localPath: "/repo" }),
        blobs({ "refs/remotes/origin/main": "" }),
      ),
    ).toEqual({ rootSteps: 0, aptPackages: { packages: [], refused: [], invalid: false } });
  });

  test("cannot tell without a checkout or a default branch", async () => {
    expect(await readProjectSetupRequirements("p1", contextWith({ id: "p1" }), blobs({}))).toEqual({
      rootSteps: null,
      aptPackages: null,
    });
    expect(
      await readProjectSetupRequirements(
        "p1",
        contextWith({ id: "p1", localPath: "/repo" }),
        blobs({}),
      ),
    ).toEqual({ rootSteps: null, aptPackages: null });
  });

  test("reads the default branch's declared Debian packages", async () => {
    const config = JSON.stringify({
      aptPackages: ["libvips-dev", "ffmpeg", "libvips-dev", "sudo", "bad;name"],
      setupContainer: ["bun install"],
    });
    expect(
      await readProjectSetupRequirements(
        "p1",
        contextWith({ id: "p1", localPath: "/repo" }),
        blobs({ "refs/remotes/origin/main": config }),
      ),
    ).toEqual({
      rootSteps: 0,
      aptPackages: {
        packages: ["libvips-dev", "ffmpeg"],
        refused: [
          { name: "sudo", reason: "denied" },
          { name: "bad;name", reason: "malformed" },
        ],
        invalid: false,
      },
    });
  });

  test("an unknown project is an error, not an answer", async () => {
    await expect(readProjectSetupRequirements("p1", contextWith(null), blobs({}))).rejects.toThrow(
      "Project not found: p1",
    );
  });
});
