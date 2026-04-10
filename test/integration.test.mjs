import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { streamChat } from "../lib/openclaw.mjs";
import { createApp } from "../lib/server.mjs";
import { clearCalls } from "../lib/calls.mjs";

// These tests hit real APIs. They skip gracefully if env vars aren't set.
// Run with: OPENCLAW_API_TOKEN=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=... node --test test/integration.test.mjs

const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL || "http://127.0.0.1:18789";
const OPENCLAW_API_TOKEN = process.env.OPENCLAW_API_TOKEN;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

const hasOpenClaw = !!OPENCLAW_API_TOKEN;
const hasTwilio = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);

describe("Integration: Twilio credentials", { skip: !hasTwilio && "TWILIO_* env vars not set" }, () => {
  it("verifies Twilio account is active", async () => {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    assert.ok(res.ok, `Twilio returned ${res.status} — credentials may be invalid`);
    const data = await res.json();
    assert.equal(data.sid, TWILIO_SID);
    assert.equal(data.status, "active");
  });

  it("verifies the from number belongs to the account", async () => {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
    const encoded = encodeURIComponent(TWILIO_FROM);
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encoded}`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    const data = await res.json();
    assert.ok(
      data.incoming_phone_numbers?.length > 0,
      `${TWILIO_FROM} not found on this Twilio account`,
    );
  });
});

describe("Integration: OpenClaw streaming", { skip: !hasOpenClaw && "OPENCLAW_API_TOKEN not set" }, () => {
  it("streams a real response from the OpenClaw gateway", async () => {
    const tokens = [];
    for await (const token of streamChat({
      messages: [
        { role: "system", content: "Reply with exactly one word." },
        { role: "user", content: "Say hello" },
      ],
      sessionKey: `voice:integration-test-${Date.now()}`,
      apiUrl: OPENCLAW_API_URL,
      apiToken: OPENCLAW_API_TOKEN,
    })) {
      tokens.push(token);
    }
    const fullResponse = tokens.join("");
    assert.ok(tokens.length > 0, "Should receive at least one token");
    assert.ok(fullResponse.length > 0, `Response was empty — got ${tokens.length} empty tokens`);
  });
});

describe("Integration: Full WebSocket conversation", { skip: !hasOpenClaw && "OPENCLAW_API_TOKEN not set" }, () => {
  const TMP_DIR = join(import.meta.dirname, ".tmp-integration-test");
  let app;
  let port;

  before(async () => {
    clearCalls();
    mkdirSync(TMP_DIR, { recursive: true });
    app = createApp({
      publicUrl: "https://voice.example.com",
      voiceId: "test-voice",
      defaultSystemPrompt: "You are a test assistant. Keep responses very short.",
      defaultWelcomeGreeting: "Hi",
      openclawApiUrl: OPENCLAW_API_URL,
      openclawApiToken: OPENCLAW_API_TOKEN,
      dataDir: TMP_DIR,
      twilioAuthToken: "integration-test-token",
    });
    const address = await app.listen({ port: 0 });
    port = new URL(address).port;
  });

  after(async () => {
    if (app) await app.close();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("receives AI response through WebSocket after setup + prompt", { timeout: 30000 }, async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    // Setup — simulates ConversationRelay connection
    ws.send(JSON.stringify({
      type: "setup",
      callSid: `CAintegration${Date.now()}`,
      from: "+1111111111",
      to: "+2222222222",
      customParameters: { systemPrompt: "Reply with one short sentence." },
    }));
    await new Promise(r => setTimeout(r, 200));

    // Prompt — simulates transcribed caller speech
    const responses = [];
    const done = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for AI response (30s)")), 29000);
      ws.onmessage = (event) => {
        const parsed = JSON.parse(event.data);
        responses.push(parsed);
        if (parsed.last === true) {
          clearTimeout(timeout);
          resolve();
        }
      };
    });

    ws.send(JSON.stringify({
      type: "prompt",
      voicePrompt: "What is 2 plus 2?",
    }));

    await done;

    const fullResponse = responses.map(r => r.token || "").join("");
    assert.ok(responses.length >= 1, "Should receive at least one message");
    assert.ok(fullResponse.length > 0, "AI response should not be empty");
    assert.equal(responses[responses.length - 1].last, true, "Final message should have last:true");

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it("handles multi-turn conversation", { timeout: 60000 }, async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    ws.send(JSON.stringify({
      type: "setup",
      callSid: `CAmultiturn${Date.now()}`,
      from: "+1111111111",
      to: "+2222222222",
      customParameters: { systemPrompt: "You are a helpful assistant. Keep answers very short." },
    }));
    await new Promise(r => setTimeout(r, 200));

    // Helper to send a prompt and collect full response
    async function ask(text) {
      const responses = [];
      const done = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out on: "${text}"`)), 29000);
        ws.onmessage = (event) => {
          const parsed = JSON.parse(event.data);
          responses.push(parsed);
          if (parsed.last === true) {
            clearTimeout(timeout);
            resolve();
          }
        };
      });
      ws.send(JSON.stringify({ type: "prompt", voicePrompt: text }));
      await done;
      return responses.map(r => r.token || "").join("");
    }

    // Turn 1
    const reply1 = await ask("My name is TestBot. Remember it.");
    assert.ok(reply1.length > 0, "Turn 1 should get a response");

    // Turn 2 — tests that conversation history is maintained
    const reply2 = await ask("What is my name?");
    assert.ok(reply2.length > 0, "Turn 2 should get a response");
    assert.ok(
      reply2.toLowerCase().includes("testbot"),
      `Expected AI to remember the name "TestBot", got: "${reply2}"`,
    );

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });
});
