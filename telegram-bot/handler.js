const SUPPORTED_EXTENSIONS = new Set(["apkg", "pdf", "xlsx", "csv", "docx", "doc"]);

function telegramCommand(text) {
  const command = text.trim().match(/^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s|$)/i);
  return command?.[1].toLowerCase();
}

export function createTelegramUpdateHandler({
  api,
  studyBot,
  parseStudyFile,
  generateCards,
  maxFileBytes,
  logger = console,
}) {
  if (!api || !studyBot || !parseStudyFile || !generateCards || !maxFileBytes) {
    throw new Error("Telegram update handler requires the bot API, study workflow, file parsers, and file limit.");
  }

  return async function handleUpdate(update) {
    const message = update?.message;
    if (!message || !Number.isSafeInteger(message.chat?.id) || !message.chat?.type) return;
    const chatId = message.chat.id;
    const from = message.from;
    if (from?.is_bot) return;

    if (message.chat.type !== "private") {
      await api.sendMessage(chatId, "Please message me in a private chat to keep study sessions and answers private.");
      return;
    }

    if (message.document) {
      const document = message.document;
      const filename = typeof document.file_name === "string" && document.file_name
        ? document.file_name
        : "study-file";
      if (!document.file_id) {
        await api.sendMessage(chatId, "Telegram did not provide a downloadable document. Please send it again.");
        return;
      }
      const extension = filename.split(".").pop()?.toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        await api.sendMessage(chatId, "Please send a study file: .apkg, .pdf, .xlsx, .csv, .docx or .doc.");
        return;
      }
      if (Number.isSafeInteger(document.file_size) && document.file_size > maxFileBytes) {
        await api.sendMessage(chatId, "That file is over the 20 MB study-bot limit.");
        return;
      }
      try {
        await api.sendMessage(chatId, `I received *${filename}*. Reading it and preparing your recall questions…`);
        const file = await api.getFile(document.file_id);
        if (file.file_size !== undefined && file.file_size > maxFileBytes) {
          throw new Error("That file is over the 20 MB study-bot limit.");
        }
        const buffer = await api.downloadFile(file.file_path, maxFileBytes);
        const parsed = await parseStudyFile(buffer, filename);
        const cards = parsed.cards.length ? parsed.cards : await generateCards(parsed.text, filename);
        if (!cards.length) throw new Error("I couldn't make any usable questions from that file.");
        await studyBot.startSession(String(chatId), filename, cards);
      } catch (error) {
        logger.error("Telegram document processing failed:", error instanceof Error ? error.message : "unknown error");
        await api.sendMessage(
          chatId,
          `I couldn't prepare that file: ${error instanceof Error ? error.message : "unsupported or unreadable file"}`,
        );
      }
      return;
    }

    if (typeof message.text === "string") {
      const command = telegramCommand(message.text);
      if (command === "start") {
        await studyBot.handleText(String(chatId), "help");
      } else if (command && ["help", "next", "continue", "skip", "repeat", "stop", "reset", "cancel"].includes(command)) {
        await studyBot.handleText(String(chatId), command);
      } else {
        await studyBot.handleText(String(chatId), message.text);
      }
      return;
    }

    await api.sendMessage(
      chatId,
      "Send a study file as a document (.apkg, .pdf, .xlsx, .csv, .docx, or .doc), or type /help for instructions.",
    );
  };
}
