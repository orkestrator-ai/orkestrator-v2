import { useId, useRef } from "react";
import { ClaudeIcon, CodexIcon, CursorAgentIcon, GrokBuildIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { LAUNCH_AGENT_OPTIONS, type LaunchAgent } from "@/lib/agent-launch";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores";
import { LEGACY_ENABLED_AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";

export function AgentIcon({
  agent,
  className,
}: {
  agent: LaunchAgent;
  className?: string;
}) {
  if (agent === "claude") return <ClaudeIcon className={className} />;
  if (agent === "codex") return <CodexIcon className={className} />;
  if (agent === "cursor") return <CursorAgentIcon className={className} />;
  if (agent === "grok") return <GrokBuildIcon className={className} />;
  return <OpenCodeIcon className={className} />;
}

interface AgentRadioGroupProps {
  value: LaunchAgent;
  onChange: (agent: LaunchAgent) => void;
  /** Accessible name of the group; also disambiguates repeated groups. */
  label: string;
  /** Optional per-agent caption. Cards stay single-line when omitted. */
  descriptions?: Partial<Record<LaunchAgent, string>>;
}

/**
 * A roving-focus radio group of native agents.
 *
 * Native inputs kept visually hidden behind styled labels rather than styled
 * buttons: the selection has to be reachable by keyboard and readable by a
 * screen reader as one group, which is what a real radiogroup already gives.
 */
export function AgentRadioGroup({
  value,
  onChange,
  label,
  descriptions,
}: AgentRadioGroupProps) {
  const enabledPlatforms = useConfigStore(
    (state) => state.config.global.enabledAgentPlatforms ?? LEGACY_ENABLED_AGENT_PLATFORMS,
  );
  const options = LAUNCH_AGENT_OPTIONS.filter((option) =>
    enabledPlatforms.includes(option.value)
  );
  const groupId = useId();
  const radioRefs = useRef(new Map<LaunchAgent, HTMLInputElement>());

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const values = options.map((option) => option.value);
    const index = Math.max(values.indexOf(value), 0);
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (index + 1) % values.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + values.length) % values.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = values.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextValue = values[next]!;
    onChange(nextValue);
    radioRefs.current.get(nextValue)?.focus();
  };

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const selected = value === option.value;
        const id = `${groupId}-${option.value}`;
        const description = descriptions?.[option.value];
        return (
          <div key={option.value} className="relative min-w-0">
            <input
              ref={(node) => {
                if (node) radioRefs.current.set(option.value, node);
                else radioRefs.current.delete(option.value);
              }}
              id={id}
              type="radio"
              name={`${groupId}-agent`}
              checked={selected}
              tabIndex={selected ? 0 : -1}
              onChange={() => onChange(option.value)}
              onKeyDown={handleKeyDown}
              className="peer sr-only"
            />
            <label
              htmlFor={id}
              className={cn(
                "flex cursor-pointer flex-col rounded-lg border px-3 py-2.5 transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-400/70",
                description && "min-h-20",
                selected
                  ? "border-cyan-400/55 bg-cyan-500/10 text-zinc-100"
                  : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <AgentIcon agent={option.value} className="size-4" />
                {option.label}
              </span>
              {description && (
                <span className="mt-1 text-[11px] leading-snug text-zinc-500">
                  {description}
                </span>
              )}
            </label>
          </div>
        );
      })}
    </div>
  );
}
