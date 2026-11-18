import assert from "node:assert/strict";
import test from "node:test";
import { runLongPolling } from "./polling.js";

test("long polling acknowledges update offsets and processes updates in order", async () => {
  const requests = [];
  const handled = [];
  const shutdown = new AbortController();
  await runLongPolling({
    getUpdates: async (offset) => {
      requests.push(offset);
      if (requests.length === 1) return [{ update_id: 4 }, { update_id: 7 }];
      shutdown.abort();
      return [];
    },
    handleUpdate: async (update) => handled.push(update.update_id),
    signal: shutdown.signal,
    logger: { error() {} },
  });

  assert.deepEqual(requests, [0, 8]);
  assert.deepEqual(handled, [4, 7]);
});

test("retries polling failures and keeps processing after an invalid update", async () => {
  const handled = [];
  const logged = [];
  const delays = [];
  const shutdown = new AbortController();
  let requests = 0;
  await runLongPolling({
    getUpdates: async () => {
      requests += 1;
      if (requests === 1) throw new Error("temporary network error");
      if (requests === 2) return [{ update_id: 1 }, { update_id: 2 }];
      shutdown.abort();
      return [];
    },
    handleUpdate: async (update) => {
      if (update.update_id === 1) throw new Error("malformed message");
      handled.push(update.update_id);
    },
    signal: shutdown.signal,
    delay: async (milliseconds) => delays.push(milliseconds),
    logger: { error: (...args) => logged.push(args) },
  });

  assert.deepEqual(delays, [3000]);
  assert.deepEqual(handled, [2]);
  assert.equal(logged.length, 2);
});
