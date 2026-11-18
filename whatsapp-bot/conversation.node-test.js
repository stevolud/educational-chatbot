import assert from "node:assert/strict";
import test from "node:test";
import { createStudyBot } from "./conversation.js";

const cards = [
  { front: "What does ATP store?", back: "Usable energy.", extra: "Cells use ATP to power processes." },
  { front: "Where is ATP produced?", back: "Mainly in mitochondria.", extra: "" },
];

function createHarness() {
  const sent = [];
  const bot = createStudyBot({
    sendText: async (to, body) => sent.push({ to, body }),
    gradeAnswer: async (_card, answer) => `Feedback on: ${answer}`,
  });
  return { bot, sent };
}

test("sends one WhatsApp question and waits before revealing its answer and extra", async () => {
  const { bot, sent } = createHarness();
  await bot.startSession("learner", "biology.apkg", cards);

  assert.equal(sent.length, 2);
  assert.match(sent[1].body, /Question 1\/2/);
  assert.match(sent[1].body, /What does ATP store\?/);
  assert.doesNotMatch(sent[1].body, /Usable energy|Cells use ATP/);

  await bot.handleText("learner", "The cell's energy source");
  assert.match(sent[2].body, /Feedback on: The cell's energy source/);
  assert.match(sent[2].body, /\*Answer:\* Usable energy\./);
  assert.match(sent[2].body, /\*Extra:\* Cells use ATP to power processes\./);
  assert.match(sent[2].body, /Reply \*next\*/);
});

test("does not advance until next, then asks the next question and completes", async () => {
  const { bot, sent } = createHarness();
  await bot.startSession("learner", "biology.apkg", cards);
  await bot.handleText("learner", "skip");
  const revealedCount = sent.length;
  await bot.handleText("learner", "I understand");
  assert.equal(sent.length, revealedCount + 1);
  assert.match(sent.at(-1).body, /Reply \*next\*/);

  await bot.handleText("learner", "next");
  assert.match(sent.at(-1).body, /Question 2\/2/);
  assert.match(sent.at(-1).body, /Where is ATP produced\?/);

  await bot.handleText("learner", "next");
  assert.match(sent.at(-1).body, /waiting for your answer/i);
  await bot.handleText("learner", "Mitochondria");
  assert.match(sent.at(-1).body, /Mainly in mitochondria/);
  assert.doesNotMatch(sent.at(-1).body, /\*Extra:\*/);
  await bot.handleText("learner", "continue");
  assert.match(sent.at(-1).body, /Session complete: 2 questions/);
});

test("skip reveals the answer and extra without grading", async () => {
  const { bot, sent } = createHarness();
  await bot.startSession("learner", "biology.apkg", cards);
  await bot.handleText("learner", "skip");

  assert.match(sent.at(-1).body, /\*Answer:\* Usable energy\./);
  assert.match(sent.at(-1).body, /\*Extra:\* Cells use ATP to power processes\./);
  assert.doesNotMatch(sent.at(-1).body, /Feedback on:/);
});

test("keeps conversations separate by WhatsApp sender", async () => {
  const { bot, sent } = createHarness();
  await bot.startSession("learner-one", "one.apkg", cards);
  await bot.startSession("learner-two", "two.apkg", cards);
  await bot.handleText("learner-one", "My answer");

  assert.equal(sent.at(-1).to, "learner-one");
  assert.match(sent.at(-1).body, /Usable energy/);
  await bot.handleText("learner-two", "skip");
  assert.equal(sent.at(-1).to, "learner-two");
  assert.match(sent.at(-1).body, /Usable energy/);
});

test("supports help and clearing an active session", async () => {
  const { bot, sent } = createHarness();
  await bot.handleText("learner", "help");
  assert.match(sent.at(-1).body, /Send a study file/);

  await bot.startSession("learner", "biology.apkg", cards);
  await bot.handleText("learner", "stop");
  assert.match(sent.at(-1).body, /session cleared/i);
  await bot.handleText("learner", "skip");
  assert.match(sent.at(-1).body, /No study session is active/);
});
