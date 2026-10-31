import { useState, type Dispatch, type SetStateAction } from "react";
import { Plus, X } from "lucide-react";
import {
  coordinatorResearchMcpServerProblem,
  MAX_COORDINATOR_RESEARCH_MCP_SERVERS,
  type CoordinatorResearchMcpServer,
  type CoordinatorWebResearch,
} from "@orkestrator/protocol/coordinator-web-research";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SETTINGS_CARD_CLASS } from "./SettingsPageLayout";

const RESEARCH_CHOICES: Array<{
  id: CoordinatorWebResearch;
  label: string;
  description: string;
}> = [
  {
    id: "search-and-mcp",
    label: "Web search and research servers (recommended)",
    description:
      "The agent's hosted web search, plus the remote research MCP servers listed below. Research servers load on Claude and Codex.",
  },
  {
    id: "search",
    label: "Web search only",
    description: "The agent's hosted web search, where its platform offers one.",
  },
  {
    id: "off",
    label: "Off",
    description: "No web search and no research servers.",
  },
];

interface CoordinatorWebResearchSettingsProps {
  mode: CoordinatorWebResearch;
  setMode: Dispatch<SetStateAction<CoordinatorWebResearch>>;
  servers: CoordinatorResearchMcpServer[];
  setServers: Dispatch<SetStateAction<CoordinatorResearchMcpServer[]>>;
}

/**
 * What a coordinator may look up on the web.
 *
 * Every mode keeps commands off the network and keeps hosted page fetches off;
 * the copy says so, because "web search" otherwise reads as "internet access".
 */
export function CoordinatorWebResearchSettings({
  mode,
  setMode,
  servers,
  setServers,
}: CoordinatorWebResearchSettingsProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const draft = { name: name.trim(), url: url.trim() };
  const draftProblem =
    !draft.name && !draft.url
      ? undefined
      : servers.some((server) => server.name === draft.name)
        ? "A research server with this name is already listed."
        : coordinatorResearchMcpServerProblem(draft);
  const canAdd =
    Boolean(draft.name && draft.url) &&
    !draftProblem &&
    servers.length < MAX_COORDINATOR_RESEARCH_MCP_SERVERS;

  return (
    <div>
      <h3 className="text-sm font-medium text-foreground">Coordinator web research</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        What a coordinator may look up while it plans. Commands it runs never reach the network, and
        it cannot open arbitrary web pages in any mode. Changes apply when a coordinator
        conversation next starts its agent.
      </p>
      <div
        role="radiogroup"
        aria-label="Coordinator web research"
        className={cn(SETTINGS_CARD_CLASS, "mt-3 gap-0 overflow-hidden")}
      >
        {RESEARCH_CHOICES.map((choice, index) => (
          <label
            key={choice.id}
            className={cn(
              "flex cursor-pointer items-start gap-3 px-4 py-3.5",
              index > 0 && "border-t border-zinc-800/80",
            )}
          >
            <input
              type="radio"
              name="coordinator-web-research"
              value={choice.id}
              checked={mode === choice.id}
              onChange={() => setMode(choice.id)}
              className="mt-1 size-3.5 shrink-0 accent-cyan-500"
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium text-foreground">{choice.label}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {choice.description}
              </span>
            </span>
          </label>
        ))}
      </div>
      {mode === "search-and-mcp" ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Remote (https) MCP servers only: a local server would run on this machine outside the
            coordinator&apos;s sandbox. The coordinator may call every tool these servers offer.
          </p>
          {servers.length === 0 ? (
            <p className="text-xs text-muted-foreground/70">No research servers listed.</p>
          ) : (
            <ul aria-label="Research servers" className="space-y-1.5">
              {servers.map((server) => (
                <li
                  key={server.name}
                  className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-xs"
                >
                  <span className="font-medium text-foreground">{server.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {server.url}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={`Remove ${server.name}`}
                    onClick={() =>
                      setServers((current) => current.filter((item) => item.name !== server.name))
                    }
                  >
                    <X className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-start gap-2">
            <Input
              aria-label="Research server name"
              placeholder="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-8 w-32 text-xs"
            />
            <Input
              aria-label="Research server URL"
              placeholder="https://…/mcp"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="h-8 flex-1 text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              disabled={!canAdd}
              onClick={() => {
                setServers((current) => [...current, draft]);
                setName("");
                setUrl("");
              }}
            >
              <Plus className="mr-1 size-3.5" />
              Add
            </Button>
          </div>
          {draftProblem ? (
            <p role="alert" className="text-xs text-destructive">
              {draftProblem}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
