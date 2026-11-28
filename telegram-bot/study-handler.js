import { createStudyBot } from "../whatsapp-bot/conversation.js";
import {
  generateCards,
  gradeAnswer,
  MAX_MEDIA_BYTES,
  parseStudyFile,
  answerTutorQuestion,
} from "../whatsapp-bot/study-files.js";
import { createTelegramUpdateHandler } from "./handler.js";

export function createStudyUpdateHandler(api, fileCatalog) {
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
    askTutor: async (question, context) => {
      try {
        return await answerTutorQuestion(question, context);
      } catch (error) {
        console.error("Local tutor unavailable:", error instanceof Error ? error.message : "unknown error");
        return "I couldn't reach the tutor right now. Please try asking again in a moment.";
      }
    },
  });

  return createTelegramUpdateHandler({
    api,
    studyBot,
    fileCatalog,
    parseStudyFile,
    generateCards,
    maxFileBytes: MAX_MEDIA_BYTES,
  });
}
