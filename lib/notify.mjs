import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { streamChat } from "./openclaw.mjs";

/**
 * Build a follow-up message from Jessica's POV summarizing what happened on a call.
 * - If the call connected and has a transcript: summarize it
 * - If the call didn't connect (no-answer, busy, failed): report it
 */
export async function buildCallSummary({
  callSid, to, status, reason, notifyContext, dataDir,
  llmApiUrl, llmApiToken, llmModel, personaPrompt,
}) {
  const transcriptPath = join(dataDir, "transcripts", `${callSid}.json`);
  const hasTranscript = existsSync(transcriptPath);

  // No-answer / busy / failed — no conversation happened
  if (!hasTranscript || ["no-answer", "busy", "failed", "canceled"].includes(status)) {
    const messages = [
      { role: "system", content: (personaPrompt || "You are Jessica.") + "\n\nYou are writing a brief text message to Seif on Telegram reporting back about a phone call you just tried to make on his behalf. Be concise, natural, and direct. No markdown. 1-2 sentences max." },
      { role: "user", content: `The call to ${to} did not go through. Twilio status: ${status}.\nReason you were calling: ${reason || "(not specified)"}\nWhat Seif asked you to find out: ${notifyContext || "(not specified)"}\n\nWrite a brief text to Seif letting him know you couldn't reach them.` },
    ];
    return await generate(messages, { llmApiUrl, llmApiToken, llmModel });
  }

  // Call connected — summarize the transcript
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  const conversation = transcript.messages
    .map(m => (m.role === "user" ? "Other party" : "You") + ": " + m.content)
    .join("\n");

  const messages = [
    { role: "system", content: (personaPrompt || "You are Jessica.") + "\n\nYou are writing a brief text message to Seif on Telegram reporting back about a phone call you just completed on his behalf. Be concise, natural, and direct — like a human giving a quick update. No markdown. 1-3 sentences. Focus on what Seif wanted to find out." },
    { role: "user", content: `You just called ${to}.\nReason you were calling: ${reason || "(not specified)"}\nWhat Seif asked you to find out: ${notifyContext || "(not specified)"}\n\nHere's the conversation:\n\n${conversation}\n\nWrite a brief text to Seif summarizing what they said — focus on answering what Seif asked you to find out.` },
  ];
  return await generate(messages, { llmApiUrl, llmApiToken, llmModel });
}

async function generate(messages, { llmApiUrl, llmApiToken, llmModel }) {
  let full = "";
  for await (const token of streamChat({ messages, apiUrl: llmApiUrl, apiToken: llmApiToken, model: llmModel })) {
    full += token;
  }
  return full.trim();
}

/**
 * Send a plain text message to Seif on Telegram via the Bot API.
 */
export async function sendTelegramMessage({ botToken, chatId, text }) {
  if (!botToken || !chatId) throw new Error("Telegram bot token or chat id not configured");
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API error: ${res.status} ${body}`);
  }
  return await res.json();
}
