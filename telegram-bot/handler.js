const SUPPORTED_EXTENSIONS = new Set(["apkg", "pdf", "xlsx", "csv", "docx", "doc"]);
const FILES_PER_PAGE = 10;

function telegramCommand(text) {
  const command = text.trim().match(/^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s|$)/i);
  return command?.[1].toLowerCase();
}

function displayFileName(fileName) {
  const normalized = fileName.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length > 100 ? `${normalized.slice(0, 97)}...` : normalized;
}

function displayFileSize(fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) return "";
  const megabytes = fileSize / (1024 * 1024);
  return megabytes >= 1 ? ` (${megabytes.toFixed(1)} MB)` : ` (${Math.max(1, Math.round(fileSize / 1024))} KB)`;
}

export function createTelegramUpdateHandler({
  api,
  studyBot,
  fileCatalog,
  parseStudyFile,
  generateCards,
  maxFileBytes,
  logger = console,
}) {
  if (!api || !studyBot || !fileCatalog || !parseStudyFile || !generateCards || !maxFileBytes) {
    throw new Error("Telegram update handler requires the bot API, study workflow, file catalog, parsers, and file limit.");
  }

  async function prepareStudyFile(chatId, fileId, filename, remember) {
    try {
      await api.sendMessage(chatId, `I’m opening *${displayFileName(filename)}* and preparing your recall questions…`);
      const file = await api.getFile(fileId);
      if (file.file_size !== undefined && file.file_size > maxFileBytes) {
        throw new Error("That file is over the 20 MB study-bot limit.");
      }
      const buffer = await api.downloadFile(file.file_path, maxFileBytes);
      const parsed = await parseStudyFile(buffer, filename);
      const cards = parsed.cards.length ? parsed.cards : await generateCards(parsed.text, filename);
      if (!cards.length) throw new Error("I couldn't make any usable questions from that file.");
      if (remember) {
        await fileCatalog.saveFile({
          chatId: String(chatId),
          fileId,
          fileName: filename,
          fileSize: file.file_size,
        });
      }
      await studyBot.startSession(String(chatId), filename, cards);
    } catch (error) {
      logger.error("Telegram document processing failed:", error instanceof Error ? error.message : "unknown error");
      await api.sendMessage(
        chatId,
        `I couldn't prepare that file: ${error instanceof Error ? error.message : "unsupported or unreadable file"}`,
      );
    }
  }

  async function sendFileList(chatId, page = 1) {
    const offset = (page - 1) * FILES_PER_PAGE;
    const { files, total } = await fileCatalog.listFiles(String(chatId), {
      limit: FILES_PER_PAGE,
      offset,
    });
    if (total === 0) {
      await api.sendMessage(chatId, "You have no saved study files yet. Upload a study document to add one.");
      return;
    }
    if (offset >= total) {
      await api.sendMessage(chatId, `There are ${total} saved files. Choose a page from 1 to ${Math.ceil(total / FILES_PER_PAGE)} with /files <page>.`);
      return;
    }

    const lines = files.map((file, index) => (
      `${offset + index + 1}. ${displayFileName(file.fileName)}${displayFileSize(file.fileSize)}${file.tag ? ` [${file.tag}]` : ""}`
    ));
    const pageCount = Math.ceil(total / FILES_PER_PAGE);
    const nextPage = page < pageCount ? `\nMore files: /files ${page + 1}` : "";
    await api.sendMessage(
      chatId,
      `*Your saved study files* (${offset + 1}-${offset + files.length} of ${total})\n${lines.join("\n")}\n\nChoose one with /use <number>, or upload a new file.${nextPage}`,
    );
  }

  async function useSavedFile(chatId, number) {
    if (!Number.isSafeInteger(number) || number < 1) {
      await api.sendMessage(chatId, "Choose a positive file number. Use /files to see your saved files.");
      return;
    }
    const { files, total } = await fileCatalog.listFiles(String(chatId), {
      limit: 1,
      offset: number - 1,
    });
    if (number > total || !files[0]) {
      await api.sendMessage(chatId, `File ${number} is not in your library. Use /files to see available files.`);
      return;
    }
    await prepareStudyFile(chatId, files[0].fileId, files[0].fileName, false);
  }

  async function tagSavedFile(chatId, number, tag) {
    if (!Number.isSafeInteger(number) || number < 1 || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(tag || "")) {
      await api.sendMessage(chatId, "Use /tag <number> <tag>, for example /tag 2 biology. Tags can use letters, numbers, underscores, and hyphens.");
      return;
    }
    try {
      const file = await fileCatalog.tagFile(String(chatId), number, tag);
      if (!file) {
        await api.sendMessage(chatId, "That file number is not in your library. Use /files to see available files.");
        return;
      }
      await api.sendMessage(
        chatId,
        `Tagged *${displayFileName(file.fileName)}* as *${file.tag}*. Load it any time with /load ${file.tag}.`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      logger.error("Telegram file tagging failed:", detail);
      await api.sendMessage(
        chatId,
        detail === "That tag is already assigned to another file in your library."
          ? detail
          : "I couldn't update your file library right now. Please try again.",
      );
    }
  }

  async function loadTaggedFile(chatId, tag) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(tag || "")) {
      await api.sendMessage(chatId, "Use /load <tag>, for example /load biology.");
      return;
    }
    let file;
    try {
      file = await fileCatalog.getFileByTag(String(chatId), tag);
    } catch (error) {
      logger.error("Telegram tagged file lookup failed:", error instanceof Error ? error.message : "unknown error");
      await api.sendMessage(chatId, "I couldn't access your file library right now. Please try again.");
      return;
    }
    if (!file) {
      await api.sendMessage(chatId, `No saved file has the tag *${tag.toLowerCase()}*. Use /files to see your library.`);
      return;
    }
    await prepareStudyFile(chatId, file.fileId, file.fileName, false);
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
      const filename = typeof document.file_name === "string" && document.file_name.trim()
        ? document.file_name.replace(/[\r\n\t]+/g, " ").trim()
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
      await prepareStudyFile(chatId, document.file_id, filename, true);
      return;
    }

    if (typeof message.text === "string") {
      const command = telegramCommand(message.text);
      if (command === "start") {
        await studyBot.handleText(String(chatId), "help");
        await api.sendMessage(chatId, "Use /ask <question> to ask Ollama about the current card (or ask a general question outside a study session). Use /files to browse saved uploads, /use 1 to study a listed file, /tag 1 biology to label one, /load biology to open it by tag, or /upload to add a new file.");
      } else if (command === "ask") {
        const match = message.text.trim().match(/^\/ask(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i);
        await studyBot.askQuestion(String(chatId), match?.[1] || "");
      } else if (command === "files" || command === "library") {
        const match = message.text.trim().match(/^\/(?:files|library)(?:@[a-z0-9_]+)?(?:\s+(\d+))?$/i);
        const page = match?.[1] ? Number(match[1]) : 1;
        if (!Number.isSafeInteger(page) || page < 1) {
          await api.sendMessage(chatId, "Use /files or /files <page> to browse your saved study files.");
        } else {
          await sendFileList(chatId, page);
        }
      } else if (command === "use") {
        const match = message.text.trim().match(/^\/use(?:@[a-z0-9_]+)?(?:\s+(\d+))?$/i);
        await useSavedFile(chatId, match?.[1] ? Number(match[1]) : NaN);
      } else if (command === "tag") {
        const match = message.text.trim().match(/^\/tag(?:@[a-z0-9_]+)?\s+(\d+)\s+([a-z0-9][a-z0-9_-]{0,31})$/i);
        await tagSavedFile(chatId, match?.[1] ? Number(match[1]) : NaN, match?.[2] || "");
      } else if (command === "load") {
        const match = message.text.trim().match(/^\/load(?:@[a-z0-9_]+)?(?:\s+([a-z0-9][a-z0-9_-]{0,31}))?$/i);
        await loadTaggedFile(chatId, match?.[1] || "");
      } else if (command === "upload") {
        await api.sendMessage(chatId, "Send a study file as a document to add it to your library and start studying.");
      } else if (command === "help") {
        await studyBot.handleText(String(chatId), "help");
        await api.sendMessage(chatId, "Use /ask <question> to ask Ollama about the current card (or ask a general question outside a study session). Use /files to browse saved uploads, /use 1 to study a listed file, /tag 1 biology to label one, /load biology to open it by tag, or /upload to add a new file.");
      } else if (command && ["next", "continue", "skip", "repeat", "stop", "reset", "cancel"].includes(command)) {
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
