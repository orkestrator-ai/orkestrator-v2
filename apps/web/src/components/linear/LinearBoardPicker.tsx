/**
 * Links a project to one Linear board: a team, optionally narrowed to one
 * Linear project in it (docs/todo/cross-cutting/7767-linear-boards-per-
 * project-and-coordinator-tools.md, task 4). The link is keyed by the
 * project's repository, so backend sync takes it to the same repository's
 * project on every machine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Link2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import type { LinearBoardLink, LinearTeam } from "@/types/linear";

/** The project select's "no narrowing" choice: Radix selects have no empty value. */
const WHOLE_TEAM = "__whole-team__";

/** "ENG / Website": the team and, when narrowed, the Linear project. */
export function linearBoardName(link: LinearBoardLink): string {
  const team = link.teamKey || link.teamName || "Linear team";
  return link.linearProjectName ? `${team} / ${link.linearProjectName}` : team;
}

function teamLabel(team: LinearTeam): string {
  if (team.key && team.name) return `${team.key} · ${team.name}`;
  return team.name || team.key || team.id;
}

type TeamsState =
  | { state: "loading" }
  | { state: "loaded"; teams: LinearTeam[] }
  | { state: "error"; message: string };

export function LinearBoardPicker({
  projectId,
  currentLink,
  onLinked,
  onCancel,
}: {
  projectId: string;
  /** The link being changed, when there is one: preselected. */
  currentLink?: LinearBoardLink | null;
  onLinked: (link: LinearBoardLink) => void;
  onCancel?: () => void;
}) {
  const nodeBackend = useScopeBackend();
  const [teams, setTeams] = useState<TeamsState>({ state: "loading" });
  const [teamId, setTeamId] = useState<string>(currentLink?.teamId ?? "");
  const [linearProjectId, setLinearProjectId] = useState<string>(
    currentLink?.linearProjectId ?? WHOLE_TEAM,
  );
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const loadTeams = useCallback(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    return nodeBackend.getLinearTeams().then(
      (next) => {
        if (requestRef.current !== requestId) return;
        setTeams({ state: "loaded", teams: next });
        // One team is the only choice: pick it.
        if (next.length === 1) setTeamId((current) => current || next[0]!.id);
      },
      (loadError: unknown) => {
        if (requestRef.current !== requestId) return;
        setTeams({
          state: "error",
          message: loadError instanceof Error ? loadError.message : "Failed to load Linear teams",
        });
      },
    );
  }, [nodeBackend]);

  // The initial state already shows this first load as loading.
  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  const team = useMemo(
    () => (teams.state === "loaded" ? teams.teams.find((entry) => entry.id === teamId) : undefined),
    [teamId, teams],
  );
  const projects = team?.projects ?? [];

  const handleLink = async () => {
    if (!teamId || linking) return;
    setLinking(true);
    setError(null);
    try {
      const link = await nodeBackend.setLinearBoardLink(
        projectId,
        teamId,
        linearProjectId === WHOLE_TEAM ? undefined : linearProjectId,
      );
      onLinked(link);
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : "Failed to link the Linear board");
    } finally {
      setLinking(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-md border border-border bg-muted/20 p-6">
      <Link2 className="mb-3 h-8 w-8 text-muted-foreground" />
      <h3 className="text-base font-medium text-foreground">
        {currentLink ? "Change Linear board" : "Link a Linear board"}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        This project shows and builds from one board: a team, or one Linear project in it. Every
        machine with this repository uses the same board.
      </p>

      {teams.state === "loading" && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading Linear teams
        </div>
      )}

      {teams.state === "error" && (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3">
          <div className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{teams.message}</span>
          </div>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => void loadTeams()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      )}

      {teams.state === "loaded" && teams.teams.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">This Linear key cannot see any teams.</p>
      )}

      {teams.state === "loaded" && teams.teams.length > 0 && (
        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="linear-board-team" className="text-xs font-medium text-foreground">
              Team
            </label>
            <Select
              value={teamId}
              onValueChange={(value) => {
                setTeamId(value);
                setLinearProjectId(WHOLE_TEAM);
                setError(null);
              }}
            >
              <SelectTrigger id="linear-board-team" className="w-full" aria-label="Linear team">
                <SelectValue placeholder="Choose a team" />
              </SelectTrigger>
              <SelectContent>
                {teams.teams.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {teamLabel(entry)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="linear-board-project" className="text-xs font-medium text-foreground">
              Linear project <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Select
              value={linearProjectId}
              onValueChange={(value) => {
                setLinearProjectId(value);
                setError(null);
              }}
              disabled={!team || projects.length === 0}
            >
              <SelectTrigger
                id="linear-board-project"
                className="w-full"
                aria-label="Linear project"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={WHOLE_TEAM}>Whole team</SelectItem>
                {projects.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name || entry.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            {onCancel && (
              <Button variant="ghost" onClick={onCancel} disabled={linking}>
                Cancel
              </Button>
            )}
            <Button onClick={() => void handleLink()} disabled={!teamId || linking}>
              {linking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
              Link board
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
