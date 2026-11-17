import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { portalStore } from "@/lib/portal/portal-store";
import { useBuildPipeline } from "@/hooks/useBuildPipeline";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import type { NetworkAccessMode } from "@/types";
import { BuildLaunchDialog } from "./BuildLaunchDialog";

const machines = [
  {
    key: "own",
    name: "Origin",
    machine: undefined,
    nodeId: "own",
    projectId: "origin-project",
    current: true,
    available: true,
    hasCheckout: true,
  },
  {
    key: "remote",
    name: "Builder",
    machine: "builder",
    nodeId: "builder",
    projectId: "destination-project",
    current: false,
    available: true,
    hasCheckout: true,
  },
];

function Launcher({ ownDefault }: { ownDefault: NetworkAccessMode }) {
  const [open, setOpen] = useState(true);
  const { startBuildFromLinearIssue } = useBuildPipeline();
  const [issueNumber, setIssueNumber] = useState(1);
  return (
    <DockerAvailabilityProvider available>
      <button
        onClick={() => {
          setIssueNumber((number) => number + 1);
          setOpen(true);
        }}
      >
        Reopen
      </button>
      <BuildLaunchDialog
        open={open}
        onOpenChange={setOpen}
        catalog={{
          claude: [{ id: "claude-a", name: "Claude A", reasoningEfforts: [] }],
          codex: [],
          opencode: [],
          cursor: [],
          grok: [],
          pi: [],
        }}
        defaultAgent="claude"
        defaultEnvironmentType="containerized"
        defaultNetworkAccessMode={ownDefault}
        machines={machines}
        onConfirm={async (selection) => {
          await startBuildFromLinearIssue(
            {
              id: `issue-${issueNumber}`,
              identifier: `ENG-${issueNumber}`,
              title: "Fixture",
              description: "",
              status: "Backlog",
              comments: [],
              createdAt: "2026-11-16T00:00:00.000Z",
              updatedAt: "2026-11-16T00:00:00.000Z",
              labels: [],
            },
            "origin-project",
            selection.environmentType,
            selection,
          );
          setOpen(false);
        }}
      />
    </DockerAvailabilityProvider>
  );
}

afterEach(cleanup);

describe("remote build network choice", () => {
  test.each(["full", "restricted"] as const)(
    "launch and reopen reads the destination's admitted choice despite origin %s",
    async (ownDefault) => {
      let saved: NetworkAccessMode | undefined;
      const submitted: unknown[] = [];
      const routed = spyOn(portalStore, "invokeOnNode").mockImplementation((async (
        _node,
        command,
        args,
      ) => {
        if (command === "check_docker") return { available: true };
        if (command === "get_config")
          return { repositories: { "destination-project": { lastBuildNetworkAccessMode: saved } } };
        if (command === "launch_build_pipeline") {
          submitted.push(args);
          saved = (args!.environmentOptions as { networkAccessMode: NetworkAccessMode })
            .networkAccessMode;
          return buildPipelineFixture({ id: "remote", projectId: "destination-project" });
        }
        throw new Error(`Unexpected command: ${command}`);
      }) as typeof portalStore.invokeOnNode);
      try {
        renderInAppCommandScope(<Launcher ownDefault={ownDefault} />);
        fireEvent.click(screen.getByRole("combobox", { name: "Machine" }));
        fireEvent.click(await screen.findByRole("option", { name: /Builder/ }));
        await waitFor(() =>
          expect(
            (screen.getByRole("button", { name: "Start build" }) as HTMLButtonElement).disabled,
          ).toBe(false),
        );
        fireEvent.click(
          within(screen.getByRole("radiogroup", { name: "Network access" })).getByRole("radio", {
            name: /Restricted/,
          }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Start build" }));
        await screen.findByRole("button", { name: "Reopen" });
        await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
        expect(saved).toBe("restricted");
        fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
        fireEvent.click(screen.getByRole("combobox", { name: "Machine" }));
        fireEvent.click(await screen.findByRole("option", { name: /Builder/ }));
        await waitFor(() =>
          expect(
            (screen.getByRole("button", { name: "Start build" }) as HTMLButtonElement).disabled,
          ).toBe(false),
        );
        expect(
          (
            within(screen.getByRole("radiogroup", { name: "Network access" })).getByRole("radio", {
              name: /Restricted/,
            }) as HTMLInputElement
          ).checked,
        ).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Start build" }));
        await waitFor(() => expect(submitted).toHaveLength(2));
        expect(submitted[1]).toMatchObject({
          source: { type: "linear", issueId: "issue-2" },
          projectId: "destination-project",
          environmentOptions: { networkAccessMode: "restricted" },
        });
      } finally {
        routed.mockRestore();
      }
    },
  );
});
