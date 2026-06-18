import { describe, expect, test } from "bun:test";
import path from "node:path";
import { resolveRendererIndexPath, resolveRuntimeRoots } from "../../../electron/paths";

describe("Electron runtime paths", () => {
  test("resolves the production renderer from the packaged app root", () => {
    expect(resolveRendererIndexPath("/Applications/Orkestrator AI.app/Contents/Resources/app.asar")).toBe(
      path.join("/Applications/Orkestrator AI.app/Contents/Resources/app.asar", "dist", "index.html"),
    );
  });

  test("resolves dev roots from the emitted Electron directory back to the repository root", () => {
    expect(resolveRuntimeRoots({
      isDev: true,
      dirname: "/repo/dist-electron/electron",
      appPath: "/unused",
      resourcesPath: "/unused/resources",
    })).toEqual({
      appRoot: "/repo",
      resourceRoot: "/repo",
    });
  });

  test("uses Electron app and resources paths in production", () => {
    expect(resolveRuntimeRoots({
      isDev: false,
      dirname: "/repo/dist-electron/electron",
      appPath: "/Applications/Orkestrator AI.app/Contents/Resources/app.asar",
      resourcesPath: "/Applications/Orkestrator AI.app/Contents/Resources",
    })).toEqual({
      appRoot: "/Applications/Orkestrator AI.app/Contents/Resources/app.asar",
      resourceRoot: "/Applications/Orkestrator AI.app/Contents/Resources",
    });
  });
});
