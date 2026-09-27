import { FileMentionMenu } from "../../apps/web/src/components/chat/FileMentionMenu";
import { SlashCommandMenu } from "../../apps/web/src/components/chat/SlashCommandMenu";
import type { FileCandidate } from "../../apps/web/src/types";

const files: FileCandidate[] = Array.from({ length: 30 }, (_, index) => ({
  filename: `file-${index}.ts`,
  relativePath: `src/file-${index}.ts`,
  isDirectory: false,
}));
const commands = Array.from({ length: 30 }, (_, index) => ({
  name: `/command-${index}`,
  source: "builtin" as const,
}));

export function MenuPlacementFixture() {
  const params = new URLSearchParams(window.location.search);
  const menu = params.get("menu") === "slash" ? "slash" : "file";
  const clipped = params.has("clip");
  const cramped = params.has("cramped");
  const anchor = (
    <div
      data-testid="menu-anchor"
      className="relative w-72"
      style={{ height: cramped ? 380 : 50, top: cramped ? 10 : undefined }}
    >
      {menu === "file" ? (
        <FileMentionMenu files={files} selectedIndex={0} onSelect={() => {}} onClose={() => {}} />
      ) : (
        <SlashCommandMenu
          commands={commands}
          selectedIndex={0}
          onSelect={() => {}}
          onClose={() => {}}
        />
      )}
    </div>
  );

  return (
    <main className="relative h-screen bg-background">
      {clipped ? (
        <div
          data-testid="menu-clip"
          className="absolute top-24 h-56 overflow-hidden"
          style={{ width: 320 }}
        >
          <div className="absolute top-40">{anchor}</div>
        </div>
      ) : (
        <div className="absolute" style={{ top: cramped ? 0 : "calc(100vh - 100px)" }}>
          {anchor}
        </div>
      )}
    </main>
  );
}
