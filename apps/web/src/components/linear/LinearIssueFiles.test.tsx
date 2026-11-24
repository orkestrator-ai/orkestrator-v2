import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import * as backend from "@/lib/backend";
import type { ScopeBackend } from "@/lib/backend/scope-backend";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { LinearIssueFile } from "@/types/linear";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import {
  LinearFileList,
  LinearFilesProvider,
  LinearMarkdown,
  useLinearIssueFiles,
} from "./LinearIssueFiles";

const ZIP = "https://uploads.linear.app/ws/aaaa/bbbb";
const LOGO = "https://uploads.linear.app/ws/cccc/dddd";

const getLinearIssueFiles = mock(
  async (_projectId: string, _issueId: string): Promise<LinearIssueFile[]> => [],
);
const nodeBackend = { getLinearIssueFiles } as unknown as ScopeBackend;
let opened: ReturnType<typeof spyOn<typeof backend, "openInBrowser">>;

function Harness({ content }: { content: string }) {
  const files = useLinearIssueFiles(nodeBackend, "project-1");
  return (
    <LinearFilesProvider files={files}>
      <button type="button" onClick={() => void files.load("issue-1")}>
        Load
      </button>
      <LinearMarkdown content={content} />
      <LinearFileList />
    </LinearFilesProvider>
  );
}

function show(content: string) {
  renderInAppCommandScope(<Harness content={content} />);
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
}

function signed(signature: string): LinearIssueFile[] {
  return [
    { url: ZIP, name: "package.zip", signedUrl: `${ZIP}?signature=${signature}` },
    { url: LOGO, name: "logo.png", signedUrl: `${LOGO}?signature=${signature}` },
  ];
}

beforeEach(() => {
  getLinearIssueFiles.mockReset();
  getLinearIssueFiles.mockResolvedValue(signed("1"));
  opened = spyOn(backend, "openInBrowser").mockResolvedValue(undefined);
  mockToastError.mockClear();
});

afterEach(() => {
  cleanup();
  opened.mockRestore();
  setSystemTime();
});

describe("a Linear issue's files", () => {
  test("show an image once its link is known, and its name when the image fails", async () => {
    show(`![logo](${LOGO})`);
    const image = await screen.findByRole("img", { name: "logo" });
    expect(image.getAttribute("src")).toBe(`${LOGO}?signature=1`);
    fireEvent.error(image);
    expect(screen.getByRole("button", { name: "Open logo" }).textContent).toBe("logo");
  });

  test("leave other links and images as they are", async () => {
    show("[docs](https://example.com/docs) ![pic](https://example.com/pic.png)");
    await screen.findByRole("region", { name: "Files" });
    fireEvent.click(screen.getByRole("link", { name: "docs" }));
    expect(opened).toHaveBeenLastCalledWith("https://example.com/docs");
    expect(screen.getByRole("img", { name: "pic" }).getAttribute("src")).toBe(
      "https://example.com/pic.png",
    );
  });

  test("read a new link when the one shown has been there too long", async () => {
    show("");
    await screen.findByRole("region", { name: "Files" });
    getLinearIssueFiles.mockResolvedValue(signed("2"));
    setSystemTime(new Date(Date.now() + 9 * 60_000));
    fireEvent.click(screen.getByRole("button", { name: "Download package.zip" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(`${ZIP}?signature=2`));
  });

  test("say why a file could not be opened", async () => {
    getLinearIssueFiles.mockRejectedValueOnce(new Error("offline"));
    show(`[package.zip](${ZIP})`);
    await waitFor(() => expect(getLinearIssueFiles).toHaveBeenCalledTimes(1));
    getLinearIssueFiles.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("link", { name: "package.zip" }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(opened).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Files" }) === null).toBe(true);
  });

  test("open the plain link, as before, on a node without the command", async () => {
    getLinearIssueFiles.mockRejectedValue(
      new Error(unknownBackendCommandMessage("get_linear_issue_files")),
    );
    show(`[package.zip](${ZIP})`);
    await waitFor(() => expect(getLinearIssueFiles).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("link", { name: "package.zip" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(ZIP));
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
