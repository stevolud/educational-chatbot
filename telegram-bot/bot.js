import { runLongPolling } from "./polling.js";
import { createStudyUpdateHandler } from "./study-handler.js";
import { createTelegramApi } from "./telegram-api.js";

async function main() {
  const api = createTelegramApi(process.env.TELEGRAM_BOT_TOKEN);
  const telegramBot = await api.call("getMe");
  if (!telegramBot?.username) throw new Error("Telegram did not return this bot's username.");

  const handleUpdate = createStudyUpdateHandler(api);

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
