import { useState } from "react";
import { AgentInfoAccountSection } from "../../apps/web/src/components/layout/AgentInfoAccountSection";
import type { AgentAccountSummary } from "@orkestrator/protocol/agent-accounts";

const host: AgentAccountSummary = {
  id: "default",
  platform: "claude",
  label: "Host login",
  isDefault: true,
  isActive: false,
  signedIn: true,
  identity: { email: "host@example.com" },
};
const work: AgentAccountSummary = {
  ...host,
  id: "work",
  label: "Work login",
  isDefault: false,
  isActive: true,
  identity: { email: "work@example.com" },
};

const fixtureState = { replaced: false };

function install() {
  fixtureState.replaced = false;
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string): Promise<T> => {
      if (command === "list_agent_accounts")
        return { accounts: [host, work], active: { claude: "work", codex: "default" } } as T;
      if (command === "get_native_agent_session_account")
        return {
          platform: "claude",
          source: "account",
          running: true,
          account: fixtureState.replaced ? work : host,
          ...(fixtureState.replaced ? {} : { pendingActive: work }),
        } as T;
      if (command === "get_agent_account_login") return { state: "idle" } as T;
      return undefined as T;
    },
  };
  return () => {
    fixtureState.replaced = true;
  };
}

export function AgentAccountStatusFixture() {
  const [replace] = useState(() => install());
  const [open, setOpen] = useState(true);
  const [activity, setActivity] = useState(0);
  return (
    <main className="mx-auto max-w-md space-y-3 p-4">
      <button onClick={() => setOpen((value) => !value)}>Toggle account panel</button>
      <button
        onClick={() => {
          replace();
          setActivity((value) => value + 1);
        }}
      >
        Start next turn
      </button>
      <div hidden={!open}>
        <AgentInfoAccountSection
          environmentId="env"
          provider="claude"
          open={open}
          refreshKey={activity}
        />
      </div>
    </main>
  );
}
