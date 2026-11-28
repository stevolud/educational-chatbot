import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { answerTutorQuestion, parseStudyFile } from "./study-files.js";

async function workbook({ worksheet, sharedStrings }) {
  const archive = new JSZip();
  archive.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="urn:relationships"><sheets><sheet name="Study" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  if (sharedStrings) archive.file("xl/sharedStrings.xml", sharedStrings);
  archive.file("xl/worksheets/sheet1.xml", worksheet);
  return archive.generateAsync({ type: "nodebuffer" });
}

test("sends tutor questions to Ollama with only the supplied unrevealed card context", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Think about the molecule's role." } }] }),
    };
  };

  try {
    const answer = await answerTutorQuestion("What does store mean?", {
      question: "What does ATP store?",
      answerRevealed: false,
    });

    assert.equal(answer, "Think about the molecule's role.");
    assert.match(request.url, /\/chat\/completions$/);
    const systemPrompt = request.body.messages.find((message) => message.role === "system").content;
    const userPayload = JSON.parse(request.body.messages.find((message) => message.role === "user").content);
    assert.match(systemPrompt, /do not state or directly give the expected answer/i);
    assert.deepEqual(userPayload, {
      question: "What does store mean?",
      studyContext: { question: "What does ATP store?", answerRevealed: false },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("imports shared-string workbook questions, answers, and extra notes", async () => {
  const buffer = await workbook({
    sharedStrings: [
      "<sst>",
      "<si><t>Question</t></si>",
      "<si><t>Answer</t></si>",
      "<si><t>Extra</t></si>",
      "<si><r><t>Recall </t></r><r><t>this fact.</t></r></si>",
      "<si><t>Paris</t></si>",
      "<si><t>It is the capital of France.</t></si>",
      "</sst>",
    ].join(""),
    worksheet: [
      "<worksheet><sheetData>",
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>',
      '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row>',
      "</sheetData></worksheet>",
    ].join(""),
  });

  assert.deepEqual(await parseStudyFile(buffer, "geography.xlsx"), {
    cards: [{
      front: "Recall this fact.",
      back: "Paris",
      extra: "It is the capital of France.",
    }],
    source: "Excel",
  });
});

test("imports inline-string workbook cells without shared strings", async () => {
  const buffer = await workbook({
    worksheet: [
      "<worksheet><sheetData>",
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Front</t></is></c><c r="B1" t="inlineStr"><is><t>Back</t></is></c></row>',
      '<row r="2"><c r="A2" t="inlineStr"><is><t>2 + 2</t></is></c><c r="B2" t="inlineStr"><is><t>4</t></is></c></row>',
      "</sheetData></worksheet>",
    ].join(""),
  });

  assert.deepEqual(await parseStudyFile(buffer, "arithmetic.xlsx"), {
    cards: [{ front: "2 + 2", back: "4", extra: "" }],
    source: "Excel",
  });
});

test("reports a valid ZIP that is missing Excel workbook structure", async () => {
  const archive = new JSZip();
  archive.file("not-a-workbook.txt", "invalid workbook");
  const buffer = await archive.generateAsync({ type: "nodebuffer" });

  await assert.rejects(
    parseStudyFile(buffer, "broken.xlsx"),
    /missing the Excel workbook structure/,
  );
});
