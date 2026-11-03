import Link from "next/link";
import { Suspense } from "react";

import { ActionForm } from "./action-form";
import { Counter } from "./counter";
import { HmrLabel } from "./hmr-label";

// Rendered per request, so the Suspense boundary below streams every time.
export const dynamic = "force-dynamic";

const STREAM_DELAY_MS = 1500;

async function Streamed() {
  await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS));
  return <p id="streamed">streamed after {STREAM_DELAY_MS} ms</p>;
}

export default function Home() {
  return (
    <main>
      <h1 id="title">Preview Next fixture</h1>
      <Suspense fallback={<p id="stream-fallback">streaming</p>}>
        <Streamed />
      </Suspense>
      <Counter />
      <HmrLabel />
      <ActionForm />
      <nav>
        <Link id="item-link" href="/items/42">
          Item 42
        </Link>{" "}
        <a id="redirect-link" href="/go">
          Redirect to item 7
        </a>
      </nav>
    </main>
  );
}
