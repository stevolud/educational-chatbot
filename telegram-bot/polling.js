export async function runLongPolling({
  getUpdates,
  handleUpdate,
  signal,
  logger = console,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollTimeout = 25,
}) {
  let offset = 0;
  while (!signal?.aborted) {
    try {
      const updates = await getUpdates(offset, pollTimeout, signal);
      if (updates.length === 0 && !signal?.aborted) {
        await delay(250);
        continue;
      }
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          await handleUpdate(update);
        } catch (error) {
          logger.error(
            "Telegram update processing failed:",
            error instanceof Error ? error.message : "unknown error",
          );
        }
      }
    } catch (error) {
      if (signal?.aborted) break;
      logger.error(
        "Telegram polling failed:",
        error instanceof Error ? error.message : "network unavailable",
      );
      await delay(3000);
    }
  }
}
