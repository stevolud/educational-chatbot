import { createStudyBot } from "../whatsapp-bot/conversation.js";
import {
  generateCards,
  gradeAnswer,
  MAX_MEDIA_BYTES,
  parseStudyFile,
} from "../whatsapp-bot/study-files.js";
import { createTelegramUpdateHandler } from "./handler.js";

export function createStudyUpdateHandler(api) {
  const studyBot = createStudyBot({
    sendText: (chatId, text) => api.sendMessage(Number(chatId), text),
    gradeAnswer: async (card, answer) => {
      try {
        return await gradeAnswer(card, answer);
      } catch (error) {
        console.error("Local answer feedback unavailable:", error instanceof Error ? error.message : "unknown error");
        return "Thanks for trying. Compare your response with the answer below.";
      }
    },
  });

  return createTelegramUpdateHandler({
    api,
    studyBot,
    parseStudyFile,
    generateCards,
    maxFileBytes: MAX_MEDIA_BYTES,
  });
}
