#!/usr/bin/env node
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./lib/server.mjs";
import { createMcpServer } from "./lib/mcp.mjs";

function buildSystemPrompt(workspaceDir) {
  if (!workspaceDir || !existsSync(workspaceDir)) return null;
  const read = (f) => {
    const p = join(workspaceDir, f);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  const identity = read("IDENTITY.md");
  const soul = read("SOUL.md");
  const user = read("USER.md");
  if (!identity && !soul) return null;
  return `You are talking on a phone call. Be conversational, concise, and natural. No markdown, no lists — this is spoken aloud. Keep responses short unless the caller asks for detail.

${identity ? `# Your Identity\n${identity}\n\n` : ""}${soul ? `# Who You Are\n${soul}\n\n` : ""}${user ? `# About Your Human\n${user}\n\n` : ""}Remember: this is a voice call. Speak like a person, not like a chatbot. No "Great question!" filler. Just help.`;
}

// Required env vars
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const LLM_API_TOKEN = process.env.LLM_API_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;

const required = {
  TWILIO_ACCOUNT_SID: TWILIO_SID,
  TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
  TWILIO_FROM_NUMBER: TWILIO_FROM,
  ELEVENLABS_VOICE_ID,
  LLM_API_TOKEN,
  PUBLIC_URL,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

// Optional env vars
const LLM_API_URL = process.env.LLM_API_URL || "https://api.z.ai/api/coding/paas/v4";
const LLM_MODEL = process.env.LLM_MODEL || "glm-5-turbo";
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "8080", 10);
const CALL_DATA_DIR = process.env.CALL_DATA_DIR || join(process.env.HOME || "/tmp", ".openclaw-twilio-voice");
const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE || join(process.env.HOME || "", ".openclaw", "workspace");
const personaPrompt = buildSystemPrompt(OPENCLAW_WORKSPACE);
const DEFAULT_SYSTEM_PROMPT = process.env.DEFAULT_SYSTEM_PROMPT || personaPrompt || "You are a helpful voice assistant. Be concise — the caller is listening, not reading.";
if (personaPrompt) console.error(`Loaded persona from ${OPENCLAW_WORKSPACE} (${personaPrompt.length} chars)`);

// Optional Telegram notifications — when notify_on_end is set on a call, send a summary here
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DEFAULT_WELCOME_GREETING = process.env.DEFAULT_WELCOME_GREETING || "Hello, how can I help you?";

// Modes:
// - "webhook" → runs only the Fastify webhook server (no MCP) — for always-on daemon
// - "mcp"     → runs only the MCP server on stdio (no webhook) — spawned by OpenClaw
// - "both"    → runs both (default for local dev)
const MODE = process.env.MODE || "both";

mkdirSync(CALL_DATA_DIR, { recursive: true });

const config = {
  twilioSid: TWILIO_SID,
  twilioToken: TWILIO_TOKEN,
  twilioFrom: TWILIO_FROM,
  twilioAuthToken: TWILIO_TOKEN,
  voiceId: ELEVENLABS_VOICE_ID,
  publicUrl: PUBLIC_URL,
  llmApiUrl: LLM_API_URL,
  llmApiToken: LLM_API_TOKEN,
  llmModel: LLM_MODEL,
  defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
  defaultWelcomeGreeting: DEFAULT_WELCOME_GREETING,
  dataDir: CALL_DATA_DIR,
  telegramBotToken: TELEGRAM_BOT_TOKEN,
  telegramChatId: TELEGRAM_CHAT_ID,
};

if (MODE === "webhook" || MODE === "both") {
  const app = createApp(config);
  await app.listen({ port: WEBHOOK_PORT, host: "0.0.0.0" });
  console.error(`Voice webhook server listening on port ${WEBHOOK_PORT}`);
}

if (MODE === "mcp" || MODE === "both") {
  const mcpServer = createMcpServer(config);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  if (MODE === "mcp") console.error(`MCP server connected on stdio`);
}
