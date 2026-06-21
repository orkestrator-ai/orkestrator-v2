import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import type { FileNode } from "@/lib/backend";

// Mock backend module BEFORE importing the hook
const mockGetFileTree = mock<(containerId: string) => Promise<FileNode[]>>(() => Promise.resolve([]));
const mockGetLocalFileTree = mock<(worktreePath: string) => Promise<FileNode[]>>(() => Promise.resolve([]));

mock.module("@/lib/backend", () => ({
  getFileTree: mockGetFileTree,
  getLocalFileTree: mockGetLocalFileTree,
}));

// Import hook AFTER mocking
import { useFileSearch } from "../../../src/hooks/useFileSearch";

// Sample file tree for testing
const createMockFileTree = (): FileNode[] => [
  {
    name: "src",
    path: "src",
    isDirectory: true,
    children: [
      {
        name: "components",
        path: "src/components",
        isDirectory: true,
        children: [
          {
            name: "Button.tsx",
            path: "src/components/Button.tsx",
            isDirectory: false,
            extension: ".tsx",
          },
          {
            name: "ButtonGroup.tsx",
            path: "src/components/ButtonGroup.tsx",
            isDirectory: false,
            extension: ".tsx",
          },
        ],
      },
      {
        name: "hooks",
        path: "src/hooks",
        isDirectory: true,
        children: [
          {
            name: "useFileSearch.ts",
            path: "src/hooks/useFileSearch.ts",
            isDirectory: false,
            extension: ".ts",
          },
          {
            name: "useFileMentions.ts",
            path: "src/hooks/useFileMentions.ts",
            isDirectory: false,
            extension: ".ts",
          },
        ],
      },
      {
        name: "utils",
        path: "src/utils",
        isDirectory: true,
        children: [
          {
            name: "searchHelpers.ts",
            path: "src/utils/searchHelpers.ts",
            isDirectory: false,
            extension: ".ts",
          },
        ],
      },
    ],
  },
  {
    name: "README.md",
    path: "README.md",
    isDirectory: false,
    extension: ".md",
  },
];

describe("useFileSearch", () => {
  beforeEach(() => {
    mockGetFileTree.mockClear();
    mockGetLocalFileTree.mockClear();
    mockGetFileTree.mockImplementation(() => Promise.resolve(createMockFileTree()));
    mockGetLocalFileTree.mockImplementation(() => Promise.resolve(createMockFileTree()));
  });

  describe("file tree loading", () => {
    test("returns empty files when no containerId or worktreePath", () => {
      const { result } = renderHook(() => useFileSearch(undefined, undefined));

      expect(result.current.flatFiles).toEqual([]);
      expect(result.current.isAvailable).toBe(false);
    });

    test("loads file tree from container when containerId provided", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      expect(mockGetFileTree).toHaveBeenCalledWith("container-123");
      expect(result.current.isAvailable).toBe(true);
    });

    test("loads file tree from local worktree when worktreePath provided", async () => {
      const { result } = renderHook(() => useFileSearch(undefined, "/path/to/worktree"));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      expect(mockGetLocalFileTree).toHaveBeenCalledWith("/path/to/worktree");
      expect(result.current.isAvailable).toBe(true);
    });

    test("prefers worktreePath over containerId when both provided", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", "/path/to/worktree"));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      expect(mockGetLocalFileTree).toHaveBeenCalledWith("/path/to/worktree");
      expect(mockGetFileTree).not.toHaveBeenCalled();
    });
  });

  describe("flat file list", () => {
    test("includes both files and directories", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      const files = result.current.flatFiles.filter((f) => !f.isDirectory);
      const directories = result.current.flatFiles.filter((f) => f.isDirectory);

      expect(files.length).toBeGreaterThan(0);
      expect(directories.length).toBeGreaterThan(0);
    });

    test("marks directories with isDirectory: true", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      const srcDir = result.current.flatFiles.find((f) => f.relativePath === "src");
      expect(srcDir).toBeDefined();
      expect(srcDir?.isDirectory).toBe(true);
    });

    test("marks files with isDirectory: false", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      const readmeFile = result.current.flatFiles.find((f) => f.relativePath === "README.md");
      expect(readmeFile).toBeDefined();
      expect(readmeFile?.isDirectory).toBe(false);
    });
  });

  describe("searchFiles scoring", () => {
    test("returns files sorted by path length when no query", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      const results = result.current.searchFiles("", 10);

      // Should be sorted by path length (shorter first)
      for (let i = 1; i < results.length; i++) {
        const prev = results[i - 1]!;
        const curr = results[i]!;
        expect(prev.relativePath.length).toBeLessThanOrEqual(curr.relativePath.length);
      }
    });

    test("prioritizes filename prefix matches (score 4)", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      // "Button" should match Button.tsx as prefix (score 4)
      const results = result.current.searchFiles("Button");

      expect(results[0]?.filename).toBe("Button.tsx");
      expect(results[1]?.filename).toBe("ButtonGroup.tsx");
    });

    test("filename contains (score 3) ranks higher than path segment prefix (score 2)", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      // "Search" appears in useFileSearch.ts filename (contains, score 3)
      // "src" appears as path segment prefix (score 2)
      const results = result.current.searchFiles("Search");

      // Files with "Search" in filename should come first
      const searchInFilename = results.filter((f) => f.filename.toLowerCase().includes("search"));
      expect(searchInFilename.length).toBeGreaterThan(0);
      expect(results[0]?.filename.toLowerCase()).toContain("search");
    });

    test("path segment prefix (score 2) ranks higher than path contains (score 1)", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      // "hook" matches "hooks" directory as segment prefix (score 2)
      // "ook" would be path contains only (score 1) - but we test "hook" here
      const results = result.current.searchFiles("hook");

      // The hooks directory and its files should appear
      const hooksResults = results.filter((f) => f.relativePath.includes("hooks"));
      expect(hooksResults.length).toBeGreaterThan(0);
    });

    test("path contains (score 1) still returns results", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      // "ooks" is a substring in "hooks" path but doesn't match any filename
      // and doesn't start any segment
      const results = result.current.searchFiles("ooks");

      // Should still find files in hooks directory
      const hooksResults = results.filter((f) => f.relativePath.includes("hooks"));
      expect(hooksResults.length).toBeGreaterThan(0);
    });

    test("sorts by path length within same score", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      // Both Button.tsx and ButtonGroup.tsx match "Button" as prefix
      const results = result.current.searchFiles("Button");

      // Button.tsx has shorter path than ButtonGroup.tsx
      expect(results[0]?.filename).toBe("Button.tsx");
      expect(results[1]?.filename).toBe("ButtonGroup.tsx");
    });

    test("respects limit parameter", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      const results = result.current.searchFiles("", 3);
      expect(results.length).toBe(3);
    });

    test("case-insensitive matching", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      const lowerResults = result.current.searchFiles("button");
      const upperResults = result.current.searchFiles("BUTTON");

      expect(lowerResults.length).toBe(upperResults.length);
      expect(lowerResults[0]?.relativePath).toBe(upperResults[0]?.relativePath);
    });

    test("returns empty array when no matches", async () => {
      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.flatFiles.length).toBeGreaterThan(0);
      });

      const results = result.current.searchFiles("zzzznonexistent");
      expect(results).toEqual([]);
    });
  });

  describe("error handling", () => {
    test("handles load error gracefully", async () => {
      mockGetFileTree.mockImplementation(() => Promise.reject(new Error("Network error")));

      const { result } = renderHook(() => useFileSearch("container-123", undefined));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe("Network error");
      expect(result.current.flatFiles).toEqual([]);
    });
  });
});
