import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  DatabaseStats,
  DiagnosticsBundlePlan,
} from "@orkestrator/protocol/backend-diagnostics";
import { DIAGNOSTICS_REDACTION_NOTICE } from "@orkestrator/protocol/backend-diagnostics";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import * as downloads from "@/lib/chat/artifact-download";
import { AccountMachineProvider } from "./account-machine";
import { DatabaseStorageCard } from "./DatabaseStorageCard";
import { DiagnosticsExportCard } from "./DiagnosticsExportCard";

afterEach(() => {
  cleanup();
  mock.restore();
});

const STATS: DatabaseStats = {
  generatedAt: "2026-11-05T12:00:00.000Z",
  main: {
    fileBytes: 2 * 1024 * 1024,
    walBytes: 4096,
    pageBytes: 4096,
    pageCount: 512,
    freelistPages: 10,
    freelistBytes: 40_960,
  },
  ledger: {
    fileBytes: 1024,
    walBytes: 0,
    pageBytes: null,
    pageCount: null,
    freelistPages: null,
    freelistBytes: null,
  },
  backups: {
    count: 3,
    bytes: 3 * 1024 * 1024,
    newestAt: "2026-11-05T11:00:00.000Z",
    kinds: {
      hourly: { count: 3, bytes: 3 * 1024 * 1024 },
      "pre-migration": { count: 0, bytes: 0 },
      ledger: { count: 0, bytes: 0 },
      "ledger-pre-migration": { count: 0, bytes: 0 },
    },
  },
  retention: {
    at: "2026-11-05T11:30:00.000Z",
    outcome: "completed",
    failedPasses: 0,
    report: {
      prunedMeasurements: 0,
      prunedMeasurementFiles: 0,
      expiredReferences: 0,
      releasedForQuota: 0,
      deletedSnapshots: 0,
      removedObjects: 2,
      removedBytes: 2048,
      storedBytes: 1024 * 1024,
      hardLimited: false,
    },
  },
  topTables: {
    main: {
      takenAt: "2026-11-05T11:00:00.000Z",
      tables: [
        { name: "store_rows", bytes: 1024 * 1024 },
        { name: "stores", bytes: 4096 },
      ],
      stores: [
        { family: "change-tracking", bytes: 700 * 1024, rows: 1200 },
        { family: "web-annotations", bytes: 2048, rows: 1 },
      ],
    },
    ledger: null,
  },
  leaseWaits: { bucketsMs: [1], families: {}, overflowed: 0, transactionsBusy: 0 },
};

const PLAN: DiagnosticsBundlePlan = {
  planId: "plan-1",
  fileName: "orkestrator-diagnostics-2026.tar.gz",
  expiresAt: "2026-11-05T12:15:00.000Z",
  archive: { bytes: 6, sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721" },
  manifest: {
    schemaVersion: 1,
    createdAt: "2026-11-05T12:00:00.000Z",
    appVersion: "2.30.0",
    platform: "linux",
    arch: "x64",
    bunVersion: "1.4.4",
    notice: DIAGNOSTICS_REDACTION_NOTICE,
    entries: [
      { path: "metrics.json", bytes: 2048, sha256: "a", description: "Metrics.", redactions: 0 },
      {
        path: "logs/essential/essential.jsonl",
        bytes: 10,
        sha256: "b",
        description: "Event log.",
        redactions: 3,
      },
    ],
    absent: [{ name: "logs/debug", reason: "Save Logs to Disk is off." }],
  },
};

function mount(node: React.ReactNode, machine: string | undefined = "other") {
  return render(
    <AccountMachineProvider value={{ machine, name: "Selected" }}>{node}</AccountMachineProvider>,
  );
}

test("the database card shows both databases, backups, retention and top tables for its machine", async () => {
  const read = spyOn(backend, "getDatabaseStats").mockResolvedValue(STATS);
  mount(<DatabaseStorageCard />);
  await screen.findByText("Main database");
  expect(read).toHaveBeenCalledWith("other");
  expect(screen.getByText("Change-tracking database")).toBeTruthy();
  expect(screen.getByText(/2\.0 MiB · write-ahead log 4\.0 KiB · free 40\.0 KiB/)).toBeTruthy();
  // No connection to the ledger: the free space is unknown, not zero.
  expect(screen.getByText(/1\.0 KiB · write-ahead log 0 B$/)).toBeTruthy();
  expect(screen.getByText(/3 backups, 3\.0 MiB/)).toBeTruthy();
  expect(screen.getByText(/1\.0 MiB stored, 2\.0 KiB removed/)).toBeTruthy();
  const tables = screen.getByRole("list", { name: "Largest tables in Main database" });
  expect(within(tables).getByText("store_rows")).toBeTruthy();
  // Beside the tables, which store fills store_rows.
  const stores = screen.getByRole("list", { name: "Largest stores in Main database" });
  expect(within(stores).getByText("change-tracking")).toBeTruthy();
  expect(within(stores).getByText("700 KiB · 1200 rows")).toBeTruthy();
  expect(within(stores).getByText("2.0 KiB · 1 row")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Largest stores in Change-tracking database" })).toBe(
    null,
  );

  fireEvent.click(screen.getByRole("button", { name: "Refresh database figures" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});

test("the database card says so when it has no figures", async () => {
  spyOn(backend, "getDatabaseStats").mockRejectedValue(new Error("not here"));
  mount(<DatabaseStorageCard />);
  await screen.findByText("Database figures unavailable");
  expect(screen.queryByText("Main database") === null).toBe(true);
});

test("the database card explains an empty database with no copies yet", async () => {
  spyOn(backend, "getDatabaseStats").mockResolvedValue({
    ...STATS,
    ledger: null,
    backups: { ...STATS.backups, count: 0, bytes: 0, newestAt: null },
    retention: null,
    topTables: { main: null, ledger: null },
  });
  mount(<DatabaseStorageCard />);
  await screen.findByText("No backups yet");
  expect(screen.getByText("No file yet")).toBeTruthy();
  expect(screen.getByText(/has not run since this backend started/)).toBeTruthy();
  expect(screen.getByText(/after the next backup copy/)).toBeTruthy();
});

test("export shows the manifest first, and saves only when asked", async () => {
  const plan = spyOn(backend, "planDiagnosticsBundle").mockResolvedValue(PLAN);
  const read = spyOn(backend, "readDiagnosticsBundle").mockImplementation(async (_id, offset) => ({
    planId: "plan-1",
    fileName: PLAN.fileName,
    archive: PLAN.archive,
    offset,
    data: offset === 0 ? btoa("abc") : btoa("def"),
    nextOffset: offset === 0 ? 3 : null,
  }));
  const download = spyOn(downloads, "downloadBlob").mockImplementation(() => undefined);
  mount(<DiagnosticsExportCard />);

  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  const dialog = await screen.findByRole("dialog");
  // Settings is itself a full-screen dialog, so this has to sit above it.
  expect(dialog.className).toContain(Z_FULLSCREEN_DIALOG);
  expect(plan).toHaveBeenCalledWith("other");
  expect(within(dialog).getByText("metrics.json")).toBeTruthy();
  expect(within(dialog).getByText("logs/essential/essential.jsonl")).toBeTruthy();
  expect(within(dialog).getByText(/3 redacted\./)).toBeTruthy();
  expect(within(dialog).getByText(/Save Logs to Disk is off\./)).toBeTruthy();
  expect(within(dialog).getByText(/not a proof/)).toBeTruthy();
  expect(within(dialog).getByText(/Nothing is uploaded/)).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole("button", { name: "Save bundle" }));
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  const [blob, name] = download.mock.calls[0]!;
  expect(name).toBe(PLAN.fileName);
  expect(await (blob as Blob).text()).toBe("abcdef");
  expect(read.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
    ["plan-1", 0, "other"],
    ["plan-1", 3, "other"],
  ]);
  expect(await screen.findByRole("status")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
});

test("cancel saves nothing, and a bundle that does not add up is not saved", async () => {
  spyOn(backend, "planDiagnosticsBundle").mockResolvedValue(PLAN);
  const read = spyOn(backend, "readDiagnosticsBundle").mockResolvedValue({
    planId: "plan-1",
    fileName: PLAN.fileName,
    archive: PLAN.archive,
    offset: 0,
    data: btoa("short"),
    nextOffset: null,
  });
  const download = spyOn(downloads, "downloadBlob").mockImplementation(() => undefined);
  mount(<DiagnosticsExportCard />);
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  let dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
  expect(read).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save bundle" }));
  await within(dialog).findByText("The bundle did not arrive intact.");
  expect(download).not.toHaveBeenCalled();
});

test("a failed plan says why and offers the button again", async () => {
  spyOn(backend, "planDiagnosticsBundle").mockRejectedValue(
    new Error("Unknown backend command: plan_diagnostics_bundle"),
  );
  mount(<DiagnosticsExportCard />);
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  const alert = await screen.findByRole("alert");
  // The one incompatibility text (plan item 1005), naming the chosen machine.
  expect(alert.textContent).toBe("Not available on Selected. Update it.");
  expect(
    (screen.getByRole("button", { name: "Export diagnostics" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("same-length corrupted archive bytes are refused before download", async () => {
  spyOn(backend, "planDiagnosticsBundle").mockResolvedValue(PLAN);
  spyOn(backend, "readDiagnosticsBundle").mockResolvedValue({
    planId: PLAN.planId,
    fileName: PLAN.fileName,
    archive: PLAN.archive,
    offset: 0,
    data: btoa("abcdeg"),
    nextOffset: null,
  });
  const download = spyOn(downloads, "downloadBlob").mockImplementation(() => undefined);
  mount(<DiagnosticsExportCard />);
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save bundle" }));
  await within(dialog).findByText("The bundle did not arrive intact.");
  expect(download).not.toHaveBeenCalled();
});

for (const corrupt of [false, true]) {
  test(`export without Web Crypto ${corrupt ? "rejects corrupted bytes" : "saves valid bytes"}`, async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    try {
      spyOn(backend, "planDiagnosticsBundle").mockResolvedValue(PLAN);
      spyOn(backend, "readDiagnosticsBundle").mockResolvedValue({
        planId: PLAN.planId,
        fileName: PLAN.fileName,
        archive: PLAN.archive,
        offset: 0,
        data: btoa(corrupt ? "abcdeg" : "abcdef"),
        nextOffset: null,
      });
      const download = spyOn(downloads, "downloadBlob").mockImplementation(() => undefined);
      mount(<DiagnosticsExportCard />);
      fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Save bundle" }));
      if (corrupt) {
        await within(dialog).findByText("The bundle did not arrive intact.");
        expect(download).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
        expect(await (download.mock.calls[0]![0] as Blob).text()).toBe("abcdef");
      }
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original);
      else Reflect.deleteProperty(globalThis, "crypto");
    }
  });
}

test("container logs are opt-in per environment, and choosing rebuilds the bundle", async () => {
  const offered: DiagnosticsBundlePlan = {
    ...PLAN,
    containerLogs: [
      { environmentId: "env-a", name: "Alpha", status: "running", included: false },
      { environmentId: "env-b", name: "Beta", status: "stopped", included: false },
    ],
  };
  const withLogs: DiagnosticsBundlePlan = {
    ...PLAN,
    planId: "plan-2",
    manifest: {
      ...PLAN.manifest,
      entries: [
        ...PLAN.manifest.entries,
        {
          path: "logs/containers/env-a/codex-bridge.log",
          bytes: 4096,
          sha256: "c",
          description: "Raw output of the codex server.",
          redactions: 2,
        },
      ],
    },
    containerLogs: [
      { environmentId: "env-a", name: "Alpha", status: "running", included: true },
      { environmentId: "env-b", name: "Beta", status: "stopped", included: false },
    ],
  };
  const plan = spyOn(backend, "planDiagnosticsBundle")
    .mockResolvedValueOnce(offered)
    .mockResolvedValueOnce(withLogs);
  mount(<DiagnosticsExportCard />);
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  const dialog = await screen.findByRole("dialog");

  // Nothing is chosen by default, and the first plan read no container.
  expect(plan.mock.calls[0]).toEqual(["other"]);
  const alpha = within(dialog).getByRole("checkbox", { name: "Alpha" });
  expect(alpha.getAttribute("aria-checked")).toBe("false");
  const rebuild = () =>
    within(dialog).getByRole("button", { name: /Rebuild/ }) as HTMLButtonElement;
  expect(rebuild().disabled).toBe(true);
  expect(within(dialog).queryByText("logs/containers/env-a/codex-bridge.log")).toBeNull();

  fireEvent.click(alpha);
  expect(within(dialog).getByRole("status").textContent).toContain("Not in the bundle yet");
  expect(rebuild().disabled).toBe(false);
  fireEvent.click(rebuild());

  // The manifest shown is the new plan's, holding exactly the chosen logs.
  await within(dialog).findByText("logs/containers/env-a/codex-bridge.log");
  expect(plan.mock.calls[1]).toEqual(["other", { containerLogs: ["env-a"] }]);
  expect(within(dialog).getByRole("checkbox", { name: "Alpha" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(rebuild().disabled).toBe(true);
  expect(within(dialog).queryByRole("status")).toBeNull();
});

test("a backend that offers no container logs shows no choice", async () => {
  spyOn(backend, "planDiagnosticsBundle").mockResolvedValue(PLAN);
  mount(<DiagnosticsExportCard />);
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByText("Container server logs (optional)")).toBeNull();
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
});

test("a failed rebuild keeps the old manifest and selection available for retry", async () => {
  const offered = {
    ...PLAN,
    containerLogs: [
      { environmentId: "env-a", name: "Alpha", status: "running" as const, included: false },
    ],
  };
  const plan = spyOn(backend, "planDiagnosticsBundle")
    .mockResolvedValueOnce(offered)
    .mockRejectedValueOnce(new Error("Rebuild unavailable"))
    .mockResolvedValueOnce({
      ...offered,
      planId: "retry-plan",
      containerLogs: [{ ...offered.containerLogs[0]!, included: true }],
    });
  mount(<DiagnosticsExportCard />);
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Alpha" }));
  fireEvent.click(within(dialog).getByRole("button", { name: /Rebuild/ }));
  await within(dialog).findByText("Rebuild unavailable");
  expect(within(dialog).getByText("metrics.json")).toBeTruthy();
  expect(within(dialog).getByRole("checkbox", { name: "Alpha" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  const retry = within(dialog).getByRole("button", { name: /Rebuild/ }) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  fireEvent.click(retry);
  await waitFor(() => expect(plan).toHaveBeenCalledTimes(3));
  expect(plan.mock.calls[2]).toEqual(["other", { containerLogs: ["env-a"] }]);
});
