#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./lib/server.mjs";
import { createMcpServer } from "./lib/mcp.mjs";

// Required env vars
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const OPENCLAW_API_TOKEN = process.env.OPENCLAW_API_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;

const required = {
  TWILIO_ACCOUNT_SID: TWILIO_SID,
  TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
  TWILIO_FROM_NUMBER: TWILIO_FROM,
  ELEVENLABS_VOICE_ID,
  OPENCLAW_API_TOKEN,
  PUBLIC_URL,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

// Optional env vars
const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL || "http://127.0.0.1:18789";
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "8080", 10);
const CALL_DATA_DIR = process.env.CALL_DATA_DIR || join(process.env.HOME || "/tmp", ".openclaw-twilio-voice");
const DEFAULT_SYSTEM_PROMPT = process.env.DEFAULT_SYSTEM_PROMPT || "You are a helpful voice assistant. Be concise — the caller is listening, not reading.";
const DEFAULT_WELCOME_GREETING = process.env.DEFAULT_WELCOME_GREETING || "Hello, how can I help you?";

mkdirSync(CALL_DATA_DIR, { recursive: true });

const config = {
  twilioSid: TWILIO_SID,
  twilioToken: TWILIO_TOKEN,
  twilioFrom: TWILIO_FROM,
  twilioAuthToken: TWILIO_TOKEN,
  voiceId: ELEVENLABS_VOICE_ID,
  publicUrl: PUBLIC_URL,
  openclawApiUrl: OPENCLAW_API_URL,
  openclawApiToken: OPENCLAW_API_TOKEN,
  defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
  defaultWelcomeGreeting: DEFAULT_WELCOME_GREETING,
  dataDir: CALL_DATA_DIR,
};

// Start Fastify webhook server
const app = createApp(config);
await app.listen({ port: WEBHOOK_PORT, host: "0.0.0.0" });
console.error(`Voice webhook server listening on port ${WEBHOOK_PORT}`);

// Start MCP server on stdio
const mcpServer = createMcpServer(config);
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
