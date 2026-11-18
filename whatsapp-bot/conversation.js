const SUPPORTED_FILES = ".apkg, .pdf, .xlsx, .csv, .docx, or .doc";

function cardAnswer(card) {
  return `*Answer:* ${card.back}${card.extra ? `\n\n*Extra:* ${card.extra}` : ""}`;
}

export function createStudyBot({ sendText, gradeAnswer }) {
  const sessions = new Map();

  async function sendQuestion(to, session) {
    const card = session.cards[session.index];
    session.awaitingNext = false;
    await sendText(
      to,
      `*Question ${session.index + 1}/${session.cards.length}*\n\n${card.front}\n\nReply with what you remember. I'll wait for your answer before revealing it.`,
    );
  }

  async function startSession(to, name, cards) {
    if (!Array.isArray(cards) || cards.length === 0) {
      throw new Error("A study session needs at least one question.");
    }
    const session = { name, cards, index: 0, awaitingNext: false };
    sessions.set(to, session);
    await sendText(to, `Ready: *${cards.length} questions* from ${name}. I'll show one at a time.`);
    await sendQuestion(to, session);
  }

  async function handleText(to, body) {
    const text = body.trim();
    const command = text.replace(/^\/+/, "").toLowerCase();
    if (!text || command === "help") {
      await sendText(
        to,
        `Send a study file (${SUPPORTED_FILES}) to begin. I'll send one question at a time; reply with your answer to see feedback, the correct answer, and any extra notes. Reply *next* for the next question, *repeat* to see the current question or reveal again, *skip* to reveal without answering, or *stop* to end.`,
      );
      return;
    }
    if (["stop", "reset", "cancel"].includes(command)) {
      sessions.delete(to);
      await sendText(to, "Study session cleared. Send another study file whenever you are ready.");
      return;
    }

    const session = sessions.get(to);
    if (!session) {
      await handleTextWithoutSession(to, command);
      return;
    }

    if (session.awaitingNext) {
      if (["next", "continue"].includes(command)) {
        session.index += 1;
        if (session.index >= session.cards.length) {
          sessions.delete(to);
          await sendText(to, `Session complete: ${session.cards.length} questions. Send another file to study again.`);
          return;
        }
        await sendQuestion(to, session);
        return;
      }
      if (command === "repeat") {
        await sendText(to, `${cardAnswer(session.cards[session.index])}\n\nReply *next* for the next question, or *stop* to end.`);
        return;
      }
      await sendText(to, "I have revealed the answer. Reply *next* when you are ready for the next question, *repeat* to see it again, or *stop* to end.");
      return;
    }

    if (["next", "continue"].includes(command)) {
      await sendText(to, "I’m waiting for your answer. Reply with what you remember, or send *skip* to reveal the answer.");
      return;
    }
    if (command === "repeat") {
      await sendQuestion(to, session);
      return;
    }

    const card = session.cards[session.index];
    let feedback = "";
    if (command !== "skip") {
      feedback = await gradeAnswer(card, text);
    }
    const response = [
      feedback,
      cardAnswer(card),
      "Reply *next* for the next question, or *stop* to end.",
    ].filter(Boolean).join("\n\n");
    await sendText(to, response);
    session.awaitingNext = true;
  }

  async function handleTextWithoutSession(to, command) {
    if (["next", "continue", "skip", "repeat"].includes(command)) {
      await sendText(to, `No study session is active. Send a study file (${SUPPORTED_FILES}) to begin.`);
      return;
    }
    await sendText(to, `I’m ready when you are. Send a study file (${SUPPORTED_FILES}) to begin.`);
  }

  return { handleText, startSession };
}
