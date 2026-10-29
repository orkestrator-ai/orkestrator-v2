import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { compile } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import {
  graphTemplateCapabilitySummary,
  type GraphTemplateSharePreview,
} from "@orkestrator/protocol/graphs/sharing";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { GraphShareExportDialog, GraphShareImportDialog } from "./GraphShareDialogs";
import { fixtureSummary, userDetail } from "./graph-designer.test-fixtures";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

const template = { ...graphTemplateExample("multi-review"), id: "shared" };
const detail = userDetail(template);
const PUBLIC_KEY = "A".repeat(43);

function preview(patch: Partial<GraphTemplateSharePreview> = {}): GraphTemplateSharePreview {
  return {
    kind: "bundle",
    integrity: "unsigned",
    digest: "d".repeat(64),
    contentDigest: "c".repeat(64),
    templateId: "shared",
    name: "Shared review",
    customTypes: 0,
    engineDropped: false,
    compile: detail.summary.compile,
    capabilities: graphTemplateCapabilitySummary(template, compile(template)),
    ...patch,
  };
}

let handler: (command: string, args: Record<string, unknown>) => unknown;

beforeEach(() => {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
    handler(command, args),
  );
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
});

afterEach(cleanup);

function calls(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command);
}

describe("GraphShareImportDialog", () => {
  test("checks first, shows the preview, and imports only at the shown digest", async () => {
    handler = (command, args) => {
      if (command !== "graph_template_share_import") throw new Error(command);
      return args.confirmDigest
        ? { status: "imported", preview: preview(), detail }
        : { status: "preview", preview: preview({ renameTo: "shared-2", author: "Ada" }) };
    };
    const imported = mock();
    render(
      <GraphShareImportDialog
        open
        onOpenChange={() => undefined}
        projectId="p"
        onImported={imported}
      />,
    );
    fireEvent.change(screen.getByLabelText("Bundle"), { target: { value: '{"format":"x"}' } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check" }));
    });
    const section = await screen.findByRole("region", { name: "Import preview" });
    expect(section.textContent).toContain("shared-2");
    expect(section.textContent).toContain("by Ada");
    expect(section.querySelector('[data-graph-share-integrity="unsigned"]')).not.toBeNull();
    expect(within(section).getByLabelText("What this template may do")).toBeDefined();
    expect(calls("graph_template_share_import")[0]?.[1]).toEqual({
      text: '{"format":"x"}',
      projectId: "p",
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import at this digest" }));
    });
    expect(calls("graph_template_share_import")[1]?.[1]).toEqual({
      text: '{"format":"x"}',
      projectId: "p",
      confirmDigest: "d".repeat(64),
    });
    expect(imported).toHaveBeenCalledTimes(1);
  });

  test("a tampered bundle is refused with the failing check", async () => {
    handler = () => ({
      status: "refused",
      refused: "digest-mismatch",
      errors: [{ path: "digest", code: "digest_mismatch", message: "changed after export" }],
      omittedErrors: 0,
    });
    render(
      <GraphShareImportDialog
        open
        onOpenChange={() => undefined}
        projectId={null}
        onImported={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText("Bundle"), { target: { value: "{}" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check" }));
    });
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-graph-share-refused")).toBe("digest-mismatch");
    expect(alert.textContent).toContain("changed after it was exported");
    expect(screen.queryByRole("button", { name: "Import at this digest" })).toBeNull();
  });

  test("an unknown signer can be trusted from the preview", async () => {
    let trusted = false;
    handler = (command, args) => {
      if (command === "graph_sharing_key_trust") {
        trusted = true;
        expect(args).toEqual({ action: "add", publicKey: PUBLIC_KEY, label: "Ada" });
        return { installation: null, trusted: [] };
      }
      const signer = { keyId: "0123456789abcdef0123456789abcdef", publicKey: PUBLIC_KEY };
      return {
        status: "preview",
        preview: trusted
          ? preview({ integrity: "trusted-signer", signer: { ...signer, label: "Ada" } })
          : preview({ integrity: "untrusted-signer", signer }),
      };
    };
    render(
      <GraphShareImportDialog
        open
        onOpenChange={() => undefined}
        projectId={null}
        onImported={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText("Bundle"), { target: { value: "{}" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check" }));
    });
    expect(await screen.findByText(/0123 4567 89ab/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Trust this key as"), { target: { value: "Ada" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Trust key" }));
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-graph-share-integrity="trusted-signer"]')?.textContent,
      ).toContain("Signed by Ada"),
    );
  });
});

describe("GraphShareExportDialog", () => {
  test("downloads a signed bundle and shows the installation's public key", async () => {
    handler = (command, args) => {
      if (command === "graph_sharing_keys") {
        return {
          installation: {
            keyId: "0123456789abcdef0123456789abcdef",
            publicKey: PUBLIC_KEY,
            createdAt: "2026-10-29T00:00:00.000Z",
          },
          trusted: [],
        };
      }
      expect(command).toBe("graph_template_share_export");
      expect(args).toEqual({ ref: detail.summary.ref, sign: true, author: "Ada" });
      return {
        fileName: "shared.graph-bundle.json",
        text: "{}\n",
        digest: "d".repeat(64),
        contentDigest: "c".repeat(64),
        signed: true,
        keyId: "0123456789abcdef0123456789abcdef",
      };
    };
    const download = mock();
    render(
      <GraphShareExportDialog
        open
        onOpenChange={() => undefined}
        summary={detail.summary}
        onDownload={download}
        onCopy={async () => undefined}
      />,
    );
    expect(await screen.findByText(PUBLIC_KEY)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Author (optional)"), { target: { value: "Ada" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download bundle" }));
    });
    expect(download).toHaveBeenCalledWith("shared.graph-bundle.json", "{}\n");
    expect(document.querySelector("[data-graph-share-exported]")?.textContent).toContain("dddd");
  });

  test("an untrusted project template cannot be signed", async () => {
    handler = (command, args) => {
      if (command === "graph_sharing_keys") return { installation: null, trusted: [] };
      expect(args.sign).toBeUndefined();
      return {
        fileName: "x.graph-bundle.json",
        text: "{}\n",
        digest: "d".repeat(64),
        contentDigest: "c".repeat(64),
        signed: false,
      };
    };
    const summary = fixtureSummary(
      template,
      { scope: "project", projectId: "p", path: ".orkestrator/graphs/x.graph.json" },
      { trust: "untrusted" },
    );
    const copy = mock(async () => undefined);
    render(
      <GraphShareExportDialog
        open
        onOpenChange={() => undefined}
        summary={summary}
        onDownload={() => undefined}
        onCopy={copy}
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /Sign with this installation/ });
    expect(checkbox.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Approve this project template before signing/)).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy bundle" }));
    });
    expect(copy).toHaveBeenCalledWith("{}\n");
  });
});
