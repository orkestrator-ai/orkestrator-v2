import { defineLogAreas } from "./define.js";

export const WEB_CHAT_LOG_AREAS = defineLogAreas({
  "web.chat": {
    description: "Rendering the agent transcript: messages, rich blocks and question cards.",
    events: {
      "message.copy-failed": "A message could not be copied to the clipboard.",
    },
  },
  "web.native-agent": {
    description: "The native agent tab and its composer.",
    events: {
      "model-catalogue.load-failed": "The native model catalogue could not be loaded.",
    },
  },
});
