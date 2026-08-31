import { describe, expect, test } from "bun:test";

import { resolveWorkspaceRelativeFilePath } from "./workspace-file-path";

describe("resolveWorkspaceRelativeFilePath", () => {
  test.each([
    ["relative paths", "src/App.tsx", "/workspace", "src/App.tsx"],
    ["container paths", "/workspace/src/App.tsx", "/workspace", "src/App.tsx"],
    ["local worktree paths", "/tmp/project/src/App.tsx", "/tmp/project", "src/App.tsx"],
    ["Windows worktree paths", "C:\\repo\\src\\App.tsx", "c:/repo", "src/App.tsx"],
    ["redundant separators", "src//components/./App.tsx", "/workspace", "src/components/App.tsx"],
  ])("normalizes %s", (_label, filePath, workspaceRoot, expected) => {
    expect(resolveWorkspaceRelativeFilePath(filePath, workspaceRoot)).toBe(expected);
  });

  test.each([
    ["the workspace root itself", "/workspace", "/workspace"],
    ["a sibling prefix", "/workspace-other/App.tsx", "/workspace"],
    ["an unrelated absolute path", "/etc/passwd", "/workspace"],
    ["a traversal", "src/../../secret.txt", "/workspace"],
    ["a UNC path", "//server/share/App.tsx", "/workspace"],
    ["a foreign Windows path", "C:/repo/App.tsx", "/workspace"],
    ["a drive-relative path", "C:repo/App.tsx", "/workspace"],
    ["a path with a control character", "src/App.tsx\0ignored", "/workspace"],
  ])("rejects %s", (_label, filePath, workspaceRoot) => {
    expect(resolveWorkspaceRelativeFilePath(filePath, workspaceRoot)).toBeNull();
  });
});
