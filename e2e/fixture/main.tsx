import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../apps/web/src/index.css";
import {
  CreateEnvironmentDialog,
  type ClaudeOptions,
} from "../../apps/web/src/components/environments/CreateEnvironmentDialog";

declare global {
  interface Window {
    lastCreateEnvironmentOptions?: ClaudeOptions;
  }
}

function Fixture() {
  const [open, setOpen] = useState(true);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <button type="button" onClick={() => setOpen(true)}>
        Reopen dialog
      </button>
      <CreateEnvironmentDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (options) => {
          window.lastCreateEnvironmentOptions = options;
        }}
        defaultPortMappings={[
          { containerPort: 3000, hostPort: 3000, protocol: "tcp" },
        ]}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
