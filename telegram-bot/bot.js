import { createStudyBot } from "../whatsapp-bot/conversation.js";
import {
  generateCards,
  gradeAnswer,
  MAX_MEDIA_BYTES,
  parseStudyFile,
} from "../whatsapp-bot/study-files.js";
import { createTelegramUpdateHandler } from "./handler.js";
import { runLongPolling } from "./polling.js";
import { createTelegramApi } from "./telegram-api.js";

async function main() {
  const api = createTelegramApi(process.env.TELEGRAM_BOT_TOKEN);
  const telegramBot = await api.call("getMe");
  if (!telegramBot?.username) throw new Error("Telegram did not return this bot's username.");

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
  const handleUpdate = createTelegramUpdateHandler({
    api,
    studyBot,
    parseStudyFile,
    generateCards,
    maxFileBytes: MAX_MEDIA_BYTES,
  });

  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Recall Telegram bot @${telegramBot.username} is listening for messages.`);
  await runLongPolling({
    getUpdates: (offset, timeout, signal) => api.getUpdates(offset, timeout, signal),
    handleUpdate,
    signal: shutdown.signal,
  });
}

main().catch((error) => {
  console.error("Could not start Recall Telegram bot:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
