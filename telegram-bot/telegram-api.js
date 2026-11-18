const API_ORIGIN = "https://api.telegram.org";
const FILE_ORIGIN = "https://api.telegram.org";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[character]);
}

export function formatTelegramHtml(text) {
  const chunks = text.split(/(\*[^*\r\n]+\*)/g);
  return chunks.map((chunk, index) => {
    if (index % 2 === 1) return `<b>${escapeHtml(chunk.slice(1, -1))}</b>`;
    return escapeHtml(chunk);
  }).join("");
}

export function splitTelegramText(text, maxLength = 750) {
  if (!Number.isInteger(maxLength) || maxLength < 2) {
    throw new Error("Telegram text chunk size must be a whole number greater than one.");
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let end = remaining.lastIndexOf("\n", maxLength);
    if (end < Math.floor(maxLength / 2)) end = maxLength;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end -= 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function createTelegramApi(token, fetchImpl = fetch) {
  if (!token || typeof token !== "string") {
    throw new Error("Set TELEGRAM_BOT_TOKEN before starting the Telegram bot.");
  }
  const apiBase = `${API_ORIGIN}/bot${token}`;

  async function call(method, payload = {}, timeoutMs = 35_000, signal) {
    let response;
    try {
      response = await fetchImpl(`${apiBase}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`Telegram ${method} request failed: ${error instanceof Error ? error.message : "network unavailable"}`);
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Telegram ${method} returned invalid JSON (${response.status}).`);
    }
    if (!response.ok || !result?.ok) {
      const description = typeof result?.description === "string" ? result.description : "request failed";
      throw new Error(`Telegram ${method} failed (${response.status}): ${description}`);
    }
    return result.result;
  }

  async function getUpdates(offset, timeoutSeconds = 25, signal) {
    const updates = await call(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
      (timeoutSeconds + 10) * 1000,
      signal,
    );
    if (!Array.isArray(updates)) throw new Error("Telegram getUpdates did not return an update list.");
    return updates;
  }

  async function sendMessage(chatId, text) {
    for (const chunk of splitTelegramText(text)) {
      const formatted = formatTelegramHtml(chunk);
      if (formatted.length > 4096) {
        throw new Error("Telegram message formatting exceeded the Bot API message limit.");
      }
      await call("sendMessage", {
        chat_id: chatId,
        text: formatted,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
  }

  async function getFile(fileId) {
    const file = await call("getFile", { file_id: fileId });
    if (!isRecord(file) || typeof file.file_path !== "string" || !file.file_path) {
      throw new Error("Telegram did not provide a downloadable file path.");
    }
    if (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) || file.file_size < 0)) {
      throw new Error("Telegram returned an invalid file size.");
    }
    return file;
  }

  async function downloadFile(filePath, maxBytes) {
    if (typeof filePath !== "string" || !filePath) {
      throw new Error("Telegram returned an invalid file path.");
    }
    const segments = filePath.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("Telegram returned an unsupported file path.");
    }
    const safePath = segments.map((segment) => encodeURIComponent(segment)).join("/");
    const url = `${FILE_ORIGIN}/file/bot${token}/${safePath}`;
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new Error(`Telegram file download failed: ${error instanceof Error ? error.message : "network unavailable"}`);
    }
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status}).`);
    if (!response.body) throw new Error("Telegram returned an empty file response.");

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of response.body) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) throw new Error("That file is over the 20 MB study-bot limit.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, totalBytes);
  }

  return {
    call,
    downloadFile,
    getFile,
    getUpdates,
    sendMessage,
  };
}
