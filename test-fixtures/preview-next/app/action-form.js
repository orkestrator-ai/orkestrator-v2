"use client";

import { useActionState } from "react";

import { echo } from "./actions";

export function ActionForm() {
  const [state, action, pending] = useActionState(echo, { message: "" });
  return (
    <form id="action-form" action={action}>
      <input id="action-text" name="text" defaultValue="" />
      <button id="action-submit" type="submit" disabled={pending}>
        Send
      </button>
      <output id="action-result">{state.message}</output>
    </form>
  );
}
