import { describe, expect, mock, spyOn, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const { createCommandRegistry, isPaneLayoutRevisionConflict, paneLayoutRevisionConflictMessage } =
  await createCommandFixtures();

import type { CommandContext } from "./command-fixtures";

describe("pane layout commands", () => {
  test("validates and forwards pane layout envelopes", async () => {
    const persisted = {
      // Reads stay version-agnostic so the renderer can migrate legacy data.
      version: 1,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
      updatedAt: new Date(0).toISOString(),
      revision: 1,
    };
    const getPaneLayout = mock(async () => persisted);
    const savePaneLayout = mock(
      async (
        environmentId: string,
        layout: Record<string, unknown>,
        _expectedRevision: number,
      ) => ({
        ...layout,
        environmentId,
        updatedAt: new Date(0).toISOString(),
        revision: 1,
      }),
    );
    const deletePaneLayout = mock(async () => undefined);
    const context = {
      storage: {
        getPaneLayout,
        savePaneLayout,
        deletePaneLayout,
      },
    } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    await commands.get("save_pane_layout")?.(
      {
        environmentId: "env-1",
        layout: {
          version: 3,
          containerId: null,
          activePaneId: "default",
          root,
        },
        expectedRevision: 0,
      },
      context,
    );

    expect(savePaneLayout).toHaveBeenCalledWith(
      "env-1",
      {
        version: 3,
        containerId: null,
        activePaneId: "default",
        root,
      },
      0,
    );
    await expect(
      commands.get("get_pane_layout")?.({ environmentId: "env-1" }, context),
    ).resolves.toEqual(persisted);
    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
    await expect(
      commands.get("delete_pane_layout")?.({ environmentId: "env-1" }, context),
    ).resolves.toBeUndefined();
    expect(deletePaneLayout).toHaveBeenCalledWith("env-1");
    await expect(
      commands.get("delete_pane_layout")?.(
        {
          environmentId: "env-1",
          expectedRevision: 7,
        },
        context,
      ),
    ).resolves.toBeUndefined();
    expect(deletePaneLayout).toHaveBeenCalledWith("env-1", 7);
    await expect(
      commands.get("save_pane_layout")?.(
        {
          environmentId: "env-1",
          layout: { version: 3, containerId: null, activePaneId: "", root },
          expectedRevision: 0,
        },
        context,
      ),
    ).rejects.toThrow("non-empty");
    await expect(
      commands.get("save_pane_layout")?.(
        {
          environmentId: "env-1",
          layout: { version: 3, containerId: null, activePaneId: "default", root: [] },
          expectedRevision: 0,
        },
        context,
      ),
    ).rejects.toThrow("layout.root");
    await expect(
      commands.get("save_pane_layout")?.(
        {
          environmentId: "env-1",
          layout: { version: 3, containerId: null, activePaneId: "default", root },
        },
        context,
      ),
    ).rejects.toThrow("Expected expectedRevision to be a number");
  });

  test("rejects older and future pane layout writes before reaching storage", async () => {
    const savePaneLayout = mock(async () => ({}));
    const context = { storage: { savePaneLayout } } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    for (const version of [1, 2, 4]) {
      await expect(
        commands.get("save_pane_layout")?.(
          {
            environmentId: "env-1",
            layout: { version, containerId: null, activePaneId: "default", root },
            expectedRevision: 0,
          },
          context,
        ),
      ).rejects.toThrow(`Unsupported pane layout version: ${version}`);
    }

    expect(savePaneLayout).not.toHaveBeenCalled();
  });

  test("rejects a non-numeric expectedRevision before reaching storage", async () => {
    const savePaneLayout = mock(async () => ({}));
    const context = { storage: { savePaneLayout } } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };
    const layout = { version: 3, containerId: null, activePaneId: "default", root };

    for (const expectedRevision of ["0", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        commands.get("save_pane_layout")?.(
          {
            environmentId: "env-1",
            layout,
            expectedRevision,
          },
          context,
        ),
      ).rejects.toThrow("Expected expectedRevision to be a number");
    }
    expect(savePaneLayout).not.toHaveBeenCalled();
  });

  test("propagates a storage revision conflict with the marker intact", async () => {
    const conflict = new Error(paneLayoutRevisionConflictMessage(3, 5));
    const savePaneLayout = mock(async () => {
      throw conflict;
    });
    const context = { storage: { savePaneLayout } } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    const rejection = await Promise.resolve(
      commands.get("save_pane_layout")?.(
        {
          environmentId: "env-1",
          layout: { version: 3, containerId: null, activePaneId: "default", root },
          expectedRevision: 3,
        },
        context,
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(conflict);
    // The renderer's rebase-and-retry path keys off this predicate alone.
    expect(isPaneLayoutRevisionConflict(rejection)).toBe(true);
    expect(savePaneLayout).toHaveBeenCalledWith(
      "env-1",
      {
        version: 3,
        containerId: null,
        activePaneId: "default",
        root,
      },
      3,
    );
  });
});

describe("port-aware domain commands", () => {
  test("resolves parsed hosts, preserves entry labels and refuses invalid ports before DNS", async () => {
    const dns = await import("node:dns/promises");
    const resolver = dns as {
      lookup: (
        host: string,
        options: { all: true },
      ) => Promise<Array<{ address: string; family: number }>>;
    };
    const lookup = spyOn(resolver, "lookup").mockResolvedValue([
      { address: "192.0.2.15", family: 4 },
    ]);
    try {
      const commands = createCommandRegistry();
      const context = {} as CommandContext;
      const entries = [
        "service.example:5432",
        "service.example:443/udp",
        "service.example:443/tcp",
      ];
      for (const command of ["test_domain_resolution", "validate_domains"]) {
        lookup.mockClear();
        const results = await commands.get(command)?.(
          {
            domains: [
              ...entries,
              "service.example:0",
              "service.example:65536",
              "service.example:443/quic",
            ],
          },
          context,
        );
        expect(results).toEqual([
          ...entries.map((domain) => ({
            domain,
            valid: true,
            resolvable: true,
            ips: ["192.0.2.15"],
            error: null,
          })),
          ...["service.example:0", "service.example:65536", "service.example:443/quic"].map(
            (domain) => ({
              domain,
              valid: false,
              resolvable: false,
              ips: [],
              error: "Invalid domain or port",
            }),
          ),
        ]);
        expect(lookup).toHaveBeenCalledTimes(3);
        expect(
          lookup.mock.calls.every(([host, options]) => host === "service.example" && options.all),
        ).toBe(true);
      }
    } finally {
      lookup.mockRestore();
    }
  });
});
