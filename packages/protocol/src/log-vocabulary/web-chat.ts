import { defineLogAreas } from "./define.js";

export const WEB_CHAT_LOG_AREAS = defineLogAreas({
  "web.chat": {
    description: "Rendering the agent transcript: messages, rich blocks and question cards.",
    events: {
      "message.copy-failed": "A message could not be copied to the clipboard.",
      "message.long-press-failed": "A user message's long-press action failed.",
      "message.link-open-failed": "A link in a message could not be opened.",
      "message.render-failed":
        "One transcript row failed to render; fields are the bounded diagnostic.",
      "image-preview.load-failed": "An image in a message could not be loaded for preview.",
      "session-list.load-failed": "The resume dialog could not fetch the resumable sessions.",
      "question.submit-failed": "An answer to an agent's question could not be submitted.",
      "question.dismiss-failed": "An agent's question could not be dismissed.",
      "rich-block.render-failed": "A rich block's renderer failed and its source is shown instead.",
      "rich-block.copy-failed": "A rich block's copy action could not write to the clipboard.",
      "scroll-viewport.not-found":
        "The scroll viewport was still missing when polling for it ended.",
    },
  },
  "web.native-agent": {
    description: "The native agent tab and its composer.",
    events: {
      "model-catalogue.load-failed": "The native model catalogue could not be loaded.",
      "provider-lock.persist-failed": "The locked agent choice could not be saved.",
      "compose-draft.persist-failed": "A compose draft could not be saved.",
      "compose-draft.restore-failed": "A saved compose draft could not be restored.",
      "compose-draft.discard-failed": "A saved compose draft could not be discarded.",
      "paste.failed": "Pasting an image into a composer failed unexpectedly.",
      "agent-state.listen-failed": "Subscribing to a tab's agent state events failed.",
      "model-favorites.persist-failed": "The favorite model list could not be saved.",
    },
  },
});
