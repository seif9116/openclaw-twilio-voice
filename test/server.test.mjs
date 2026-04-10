import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addCall, clearCalls, getCall } from "../lib/calls.mjs";
import { createApp } from "../lib/server.mjs";

const TMP_DIR = join(import.meta.dirname, ".tmp-server-test");
const AUTH_TOKEN = "test-twilio-auth-token";

const CONFIG = {
  publicUrl: "https://voice.example.com",
  voiceId: "test-voice-id",
  defaultSystemPrompt: "You are a test assistant.",
  defaultWelcomeGreeting: "Hi there!",
  openclawApiUrl: "http://localhost:18789",
  openclawApiToken: "test-oc-token",
  dataDir: TMP_DIR,
  twilioAuthToken: AUTH_TOKEN,
};

function computeSignature(token, url, params) {
  let data = url;
  const sortedKeys = Object.keys(params).sort();
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac("sha1", token).update(data).digest("base64");
}

let app;

beforeEach(async () => {
  clearCalls();
  mkdirSync(TMP_DIR, { recursive: true });
  app = createApp(CONFIG);
  await app.ready();
});

afterEach(async () => {
  mock.restoreAll();
  await app.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("POST /inbound-call", () => {
  it("returns TwiML with ConversationRelay config", async () => {
    const url = "https://voice.example.com/inbound-call";
    const params = { CallSid: "CA123", From: "+1111" };
    const sig = computeSignature(AUTH_TOKEN, url, params);

    const res = await app.inject({
      method: "POST",
      url: "/inbound-call",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sig,
      },
      payload: new URLSearchParams(params).toString(),
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers["content-type"].includes("text/xml"));
    const body = res.body;
    assert.ok(body.includes("<ConversationRelay"));
    assert.ok(body.includes('ttsProvider="ElevenLabs"'));
    assert.ok(body.includes(`voice="${CONFIG.voiceId}"`));
    assert.ok(body.includes('transcriptionProvider="Deepgram"'));
    assert.ok(body.includes(`welcomeGreeting="${CONFIG.defaultWelcomeGreeting}"`));
    assert.ok(body.includes("wss://voice.example.com/ws"));
  });

  it("rejects requests with invalid signature", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/inbound-call",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "invalid",
      },
      payload: "CallSid=CA123",
    });
    assert.equal(res.statusCode, 403);
  });
});

describe("POST /outbound-twiml", () => {
  it("returns TwiML with system prompt from stored call", async () => {
    addCall({ callSid: "CA456", from: "+1111", to: "+2222", status: "ringing", systemPrompt: "Sell ice cream" });

    const url = "https://voice.example.com/outbound-twiml";
    const params = { CallSid: "CA456" };
    const sig = computeSignature(AUTH_TOKEN, url, params);

    const res = await app.inject({
      method: "POST",
      url: "/outbound-twiml",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sig,
      },
      payload: new URLSearchParams(params).toString(),
    });

    assert.equal(res.statusCode, 200);
    const body = res.body;
    assert.ok(body.includes("<ConversationRelay"));
    assert.ok(body.includes("Sell ice cream"));
  });

  it("falls back to default prompt for unknown call", async () => {
    const url = "https://voice.example.com/outbound-twiml";
    const params = { CallSid: "UNKNOWN" };
    const sig = computeSignature(AUTH_TOKEN, url, params);

    const res = await app.inject({
      method: "POST",
      url: "/outbound-twiml",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sig,
      },
      payload: new URLSearchParams(params).toString(),
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes(CONFIG.defaultSystemPrompt));
  });
});

describe("POST /call-status", () => {
  it("updates call status for known call", async () => {
    addCall({ callSid: "CA789", from: "+1111", to: "+2222", status: "ringing", systemPrompt: "" });

    const url = "https://voice.example.com/call-status";
    const params = { CallSid: "CA789", CallStatus: "in-progress" };
    const sig = computeSignature(AUTH_TOKEN, url, params);

    const res = await app.inject({
      method: "POST",
      url: "/call-status",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sig,
      },
      payload: new URLSearchParams(params).toString(),
    });

    assert.equal(res.statusCode, 204);
  });

  it("logs and removes call on terminal status", async () => {
    addCall({ callSid: "CA999", from: "+1111", to: "+2222", status: "in-progress", systemPrompt: "" });

    const url = "https://voice.example.com/call-status";
    const params = { CallSid: "CA999", CallStatus: "completed" };
    const sig = computeSignature(AUTH_TOKEN, url, params);

    await app.inject({
      method: "POST",
      url: "/call-status",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sig,
      },
      payload: new URLSearchParams(params).toString(),
    });

    const raw = readFileSync(join(TMP_DIR, "calls.jsonl"), "utf8").trim();
    const entry = JSON.parse(raw);
    assert.equal(entry.callSid, "CA999");
    assert.ok(entry.endedAt);
  });
});

// WebSocket tests
describe("WebSocket /ws", () => {
  it("handles setup event and registers call", async () => {
    const address = await app.listen({ port: 0 });
    const port = new URL(address).port;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    ws.send(JSON.stringify({
      type: "setup",
      callSid: "CAWS1",
      from: "+1111",
      to: "+2222",
      customParameters: { systemPrompt: "Be friendly" },
    }));

    await new Promise(r => setTimeout(r, 100));
    const call = getCall("CAWS1");
    assert.equal(call.callSid, "CAWS1");
    assert.equal(call.systemPrompt, "Be friendly");

    ws.close();
    await new Promise(r => setTimeout(r, 50));
  });

  it("handles prompt event and streams response", async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Yes"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" indeed"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join("");

    const encoder = new TextEncoder();
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseBody));
          controller.close();
        },
      }),
    }));

    const address = await app.listen({ port: 0 });
    const port = new URL(address).port;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    // Setup first
    ws.send(JSON.stringify({
      type: "setup",
      callSid: "CAWS2",
      from: "+1111",
      to: "+2222",
      customParameters: {},
    }));
    await new Promise(r => setTimeout(r, 100));

    // Then prompt and collect responses
    const responses = [];
    const done = new Promise((resolve) => {
      ws.onmessage = (event) => {
        const parsed = JSON.parse(event.data);
        responses.push(parsed);
        if (parsed.last === true) resolve();
      };
    });

    ws.send(JSON.stringify({
      type: "prompt",
      voicePrompt: "Hello?",
    }));

    await done;

    // Should get tokens + final last:true
    assert.ok(responses.length >= 2);
    const tokens = responses.filter(r => r.token).map(r => r.token);
    assert.ok(tokens.includes("Yes"));
    assert.ok(tokens.includes(" indeed"));
    assert.equal(responses[responses.length - 1].last, true);

    ws.close();
    await new Promise(r => setTimeout(r, 50));
  });
});
