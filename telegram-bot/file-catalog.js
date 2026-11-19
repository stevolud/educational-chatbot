function normalizeChatId(chatId) {
  const value = String(chatId);
  if (!/^-?\d+$/.test(value)) throw new Error("Telegram chat ID must be an integer.");
  return value;
}

function normalizePage({ limit, offset }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("File catalog page size must be from 1 to 50.");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("File catalog offset must be a non-negative whole number.");
  }
}

export function createMemoryFileCatalog() {
  const filesByChat = new Map();

  return {
    async saveFile({ chatId, fileId, fileName, fileSize }) {
      const owner = normalizeChatId(chatId);
      if (typeof fileId !== "string" || !fileId || typeof fileName !== "string" || !fileName) {
        throw new Error("A saved file needs its Telegram file ID and name.");
      }
      let files = filesByChat.get(owner);
      if (!files) {
        files = new Map();
        filesByChat.set(owner, files);
      }
      const previous = files.get(fileId);
      files.delete(fileId);
      files.set(fileId, {
        fileId,
        fileName,
        fileSize: Number.isSafeInteger(fileSize) && fileSize >= 0 ? fileSize : null,
        tag: previous?.tag || null,
        uploadedAt: new Date().toISOString(),
      });
    },
    async listFiles(chatId, { limit, offset }) {
      normalizePage({ limit, offset });
      const files = [...(filesByChat.get(normalizeChatId(chatId))?.values() || [])].reverse();
      return {
        files: files.slice(offset, offset + limit),
        total: files.length,
      };
    },
    async tagFile(chatId, number, tag) {
      const owner = normalizeChatId(chatId);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error("File number must be positive.");
      if (typeof tag !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(tag)) {
        throw new Error("Tags must start with a letter or number and contain only letters, numbers, underscores, or hyphens.");
      }
      const files = [...(filesByChat.get(owner)?.values() || [])].reverse();
      const file = files[number - 1];
      if (!file) return null;
      const normalizedTag = tag.toLowerCase();
      const collision = files.find((candidate) => (
        candidate.fileId !== file.fileId && candidate.tag?.toLowerCase() === normalizedTag
      ));
      if (collision) throw new Error("That tag is already assigned to another file in your library.");
      file.tag = normalizedTag;
      return file;
    },
    async getFileByTag(chatId, tag) {
      const owner = normalizeChatId(chatId);
      const normalizedTag = String(tag).toLowerCase();
      const files = filesByChat.get(owner)?.values() || [];
      return [...files].find((file) => file.tag === normalizedTag) || null;
    },
    async close() {},
  };
}
