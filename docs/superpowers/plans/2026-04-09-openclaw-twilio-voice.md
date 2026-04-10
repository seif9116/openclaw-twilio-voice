# openclaw-twilio-voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone MCP server + Fastify webhook server that replaces OpenClaw's broken voice-call plugin, using Twilio ConversationRelay for AI-powered phone calls routed through OpenClaw's agent.

**Architecture:** Single Node.js process runs an MCP stdio server (agent tools: make_call, hang_up, get_call_status, list_active_calls) alongside a Fastify HTTP+WebSocket server (Twilio webhooks + ConversationRelay). Conversations flow through OpenClaw's Chat Completions API. No `twilio` SDK — uses raw fetch + node:crypto for minimal dependencies.

**Tech Stack:** Node.js 22+, ESM, @modelcontextprotocol/sdk, Fastify, @fastify/websocket, @fastify/formbody, node:test, node:assert

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `LICENSE`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "openclaw-twilio-voice",
  "version": "1.0.0",
  "description": "MCP server for AI-powered phone calls via Twilio ConversationRelay — built for OpenClaw",
  "type": "module",
  "main": "index.mjs",
  "bin": {
    "openclaw-twilio-voice": "index.mjs"
  },
  "scripts": {
    "start": "node index.mjs",
    "test": "node --test test/*.test.mjs"
  },
  "keywords": [
    "mcp",
    "twilio",
    "voice",
    "phone",
    "openclaw",
    "claude-code",
    "model-context-protocol",
    "conversationrelay"
  ],
  "author": "Seif Eldin",
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "fastify": "^5.0.0",
    "@fastify/websocket": "^11.0.0",
    "@fastify/formbody": "^8.0.0"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

- [ ] **Step 2: Create .gitignore**

```
node_modules/
.env
*.jsonl
.DS_Store
```

- [ ] **Step 3: Create .env.example**

```bash
# Required
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+15551234567
ELEVENLABS_VOICE_ID=your_voice_id
OPENCLAW_API_TOKEN=your_openclaw_token
PUBLIC_URL=https://voice.example.com

# Optional
OPENCLAW_API_URL=http://127.0.0.1:18789
WEBHOOK_PORT=8080
CALL_DATA_DIR=~/.openclaw-twilio-voice
DEFAULT_SYSTEM_PROMPT="You are a helpful voice assistant. Be concise — the caller is listening, not reading."
DEFAULT_WELCOME_GREETING="Hello, how can I help you?"
```

- [ ] **Step 4: Create LICENSE**

MIT license file with `Copyright (c) 2026 Seif Eldin`.

- [ ] **Step 5: Initialize git repo and install dependencies**

```bash
cd /home/seif/projects/openclaw-twilio-voice
git init
npm install
```

- [ ] **Step 6: Create lib/ and test/ directories**

```bash
mkdir -p lib test
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example LICENSE lib test
git commit -m "chore: scaffold project with dependencies"
```

---

### Task 2: Call state management (lib/calls.mjs)

**Files:**
- Create: `test/calls.test.mjs`
- Create: `lib/calls.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/calls.test.mjs`:

```javascript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addCall, getCall, updateCall, removeCall,
  listActiveCalls, clearCalls, logCall,
} from "../lib/calls.mjs";

const TMP_DIR = join(import.meta.dirname, ".tmp-calls-test");

beforeEach(() => {
  clearCalls();
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("addCall", () => {
  it("stores a call and returns it with a startedAt timestamp", () => {
    const call = addCall({ callSid: "CA1", from: "+1111", to: "+2222", status: "queued", systemPrompt: "Be nice" });
    assert.equal(call.callSid, "CA1");
    assert.equal(call.from, "+1111");
    assert.equal(call.to, "+2222");
    assert.equal(call.status, "queued");
    assert.equal(call.systemPrompt, "Be nice");
    assert.ok(call.startedAt);
  });
});

describe("getCall", () => {
  it("returns stored call by SID", () => {
    addCall({ callSid: "CA2", from: "+1111", to: "+2222", status: "ringing", systemPrompt: "" });
    const call = getCall("CA2");
    assert.equal(call.callSid, "CA2");
  });

  it("returns null for unknown SID", () => {
    assert.equal(getCall("UNKNOWN"), null);
  });
});

describe("updateCall", () => {
  it("merges updates into existing call", () => {
    addCall({ callSid: "CA3", from: "+1111", to: "+2222", status: "queued", systemPrompt: "" });
    const updated = updateCall("CA3", { status: "in-progress" });
    assert.equal(updated.status, "in-progress");
    assert.equal(updated.from, "+1111");
  });

  it("returns null for unknown SID", () => {
    assert.equal(updateCall("NOPE", { status: "x" }), null);
  });
});

describe("removeCall", () => {
  it("removes and returns the call", () => {
    addCall({ callSid: "CA4", from: "+1111", to: "+2222", status: "in-progress", systemPrompt: "" });
    const removed = removeCall("CA4");
    assert.equal(removed.callSid, "CA4");
    assert.equal(getCall("CA4"), null);
  });

  it("returns null for unknown SID", () => {
    assert.equal(removeCall("NOPE"), null);
  });
});

describe("listActiveCalls", () => {
  it("returns all active calls", () => {
    addCall({ callSid: "CA5", from: "+1111", to: "+2222", status: "in-progress", systemPrompt: "" });
    addCall({ callSid: "CA6", from: "+3333", to: "+4444", status: "ringing", systemPrompt: "" });
    const list = listActiveCalls();
    assert.equal(list.length, 2);
    assert.ok(list.find(c => c.callSid === "CA5"));
    assert.ok(list.find(c => c.callSid === "CA6"));
  });

  it("returns empty array when no calls", () => {
    assert.deepEqual(listActiveCalls(), []);
  });
});

describe("logCall", () => {
  it("appends a JSONL entry to calls.jsonl", () => {
    logCall({ callSid: "CA7", from: "+1111", to: "+2222", status: "completed" }, TMP_DIR);
    const raw = readFileSync(join(TMP_DIR, "calls.jsonl"), "utf8").trim();
    const entry = JSON.parse(raw);
    assert.equal(entry.callSid, "CA7");
    assert.equal(entry.status, "completed");
    assert.ok(entry.ts);
  });

  it("appends multiple entries", () => {
    logCall({ callSid: "CA8", status: "completed" }, TMP_DIR);
    logCall({ callSid: "CA9", status: "failed" }, TMP_DIR);
    const lines = readFileSync(join(TMP_DIR, "calls.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/seif/projects/openclaw-twilio-voice && node --test test/calls.test.mjs
```

Expected: FAIL — `Cannot find module '../lib/calls.mjs'`

- [ ] **Step 3: Write the implementation**

Create `lib/calls.mjs`:

```javascript
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const activeCalls = new Map();

export function addCall({ callSid, from, to, status, systemPrompt }) {
  const call = { callSid, from, to, status, systemPrompt, startedAt: new Date().toISOString() };
  activeCalls.set(callSid, call);
  return call;
}

export function getCall(callSid) {
  return activeCalls.get(callSid) || null;
}

export function updateCall(callSid, updates) {
  const call = activeCalls.get(callSid);
  if (!call) return null;
  Object.assign(call, updates);
  return call;
}

export function removeCall(callSid) {
  const call = activeCalls.get(callSid);
  activeCalls.delete(callSid);
  return call || null;
}

export function listActiveCalls() {
  return Array.from(activeCalls.values());
}

export function clearCalls() {
  activeCalls.clear();
}

export function logCall(entry, dataDir) {
  const logPath = join(dataDir, "calls.jsonl");
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try { appendFileSync(logPath, line); } catch {}
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/seif/projects/openclaw-twilio-voice && node --test test/calls.test.mjs
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/calls.mjs test/calls.test.mjs
git commit -m "feat: add call state management with JSONL logging"
```

---

### Task 3: OpenClaw streaming client (lib/openclaw.mjs)

**Files:**
- Create: `test/openclaw.test.mjs`
- Create: `lib/openclaw.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/openclaw.test.mjs`:

```javascript
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// Must import after mocking in each test — use dynamic import
// We mock globalThis.fetch before importing the module

describe("streamChat", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("yields content tokens from SSE stream", async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join("");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody));
        controller.close();
      },
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      body: stream,
    }));

    const { streamChat } = await import("../lib/openclaw.mjs");
    const tokens = [];
    for await (const token of streamChat({
      messages: [{ role: "user", content: "hi" }],
      sessionKey: "voice:CA1",
      apiUrl: "http://localhost:18789",
      apiToken: "test-token",
    })) {
      tokens.push(token);
    }

    assert.deepEqual(tokens, ["Hello", " world"]);

    // Verify fetch was called with correct params
    const call = globalThis.fetch.mock.calls[0];
    assert.equal(call.arguments[0], "http://localhost:18789/v1/chat/completions");
    const opts = call.arguments[1];
    assert.equal(opts.headers["Authorization"], "Bearer test-token");
    assert.equal(opts.headers["x-openclaw-session-key"], "voice:CA1");
    const body = JSON.parse(opts.body);
    assert.equal(body.stream, true);
    assert.equal(body.model, "openclaw/main");
  });

  it("throws on non-ok response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    }));

    const { streamChat } = await import("../lib/openclaw.mjs");
    await assert.rejects(
      async () => {
        for await (const _ of streamChat({
          messages: [],
          sessionKey: "voice:CA1",
          apiUrl: "http://localhost:18789",
          apiToken: "bad",
        })) {}
      },
      /OpenClaw API error: 401/,
    );
  });

  it("supports abort via signal", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Never close — simulates long-running stream
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
      },
    });

    mock.method(globalThis, "fetch", async (url, opts) => {
      // When signal aborts, the stream read should throw
      opts.signal?.addEventListener("abort", () => {});
      return { ok: true, body: stream };
    });

    const { streamChat } = await import("../lib/openclaw.mjs");
    const controller = new AbortController();
    const tokens = [];

    // Abort after first token
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(
      async () => {
        for await (const token of streamChat({
          messages: [],
          sessionKey: "voice:CA1",
          apiUrl: "http://localhost:18789",
          apiToken: "test",
          signal: controller.signal,
        })) {
          tokens.push(token);
        }
      },
      (err) => err.name === "AbortError",
    );

    assert.deepEqual(tokens, ["Hi"]);
  });

  it("handles chunked SSE data split across reads", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delt',
      'a":{"content":"chunk"}}]}\n\ndata: [DONE]\n\n',
    ];

    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i++]));
        } else {
          controller.close();
        }
      },
    });

    mock.method(globalThis, "fetch", async () => ({ ok: true, body: stream }));

    const { streamChat } = await import("../lib/openclaw.mjs");
    const tokens = [];
    for await (const token of streamChat({
      messages: [],
      sessionKey: "voice:CA1",
      apiUrl: "http://localhost:18789",
      apiToken: "test",
    })) {
      tokens.push(token);
    }

    assert.deepEqual(tokens, ["chunk"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/seif/projects/openclaw-twilio-voice && node --test test/openclaw.test.mjs
```

Expected: FAIL — `Cannot find module '../lib/openclaw.mjs'`

- [ ] **Step 3: Write the implementation**

Create `lib/openclaw.mjs`:

```javascript
export async function* streamChat({ messages, sessionKey, apiUrl, apiToken, signal }) {
  const res = await fetch(`${apiUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiToken}`,
      "x-openclaw-session-key": sessionKey,
    },
    body: JSON.stringify({
      model: "openclaw/main",
      stream: true,
      messages,
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`OpenClaw API error: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {}
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/seif/projects/openclaw-twilio-voice && node --test test/openclaw.test.mjs
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/openclaw.mjs test/openclaw.test.mjs
git commit -m "feat: add OpenClaw Chat Completions streaming client"
```

---

### Task 4: Fastify HTTP endpoints (lib/server.mjs)

**Files:**
- Create: `test/server.test.mjs`
- Create: `lib/server.mjs`

This task covers the HTTP endpoints only. The WebSocket handler is Task 5.

- [ ] **Step 1: Write the failing tests**

Create `test/server.test.mjs`:

```javascript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addCall, clearCalls } from "../lib/calls.mjs";
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/seif/projects/openclaw-twilio-voice && node --test test/server.test.mjs
```

Expected: FAIL — `Cannot find module '../lib/server.mjs'`

- [ ] **Step 3: Write the implementation**

Create `lib/server.mjs`:

```javascript
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import { createHmac } from "node:crypto";
import { getCall, updateCall, removeCall, addCall, logCall } from "./calls.mjs";
import { streamChat } from "./openclaw.mjs";

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function validateSignature(authToken, signature, url, params) {
  let data = url;
  const sortedKeys = Object.keys(params).sort();
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  return signature === expected;
}

export function createApp(config) {
  const {
    publicUrl, voiceId, defaultSystemPrompt, defaultWelcomeGreeting,
    openclawApiUrl, openclawApiToken, dataDir, twilioAuthToken,
  } = config;

  const app = Fastify();
  app.register(fastifyFormBody);
  app.register(fastifyWebsocket);

  const wsHost = new URL(publicUrl).host;

  // Twilio signature validation hook for non-WebSocket routes
  app.addHook("preHandler", async (req, reply) => {
    // Skip WebSocket upgrade requests
    if (req.headers.upgrade === "websocket") return;
    // Skip non-Twilio routes
    const twilioRoutes = ["/inbound-call", "/outbound-twiml", "/call-status"];
    if (!twilioRoutes.includes(req.url.split("?")[0])) return;

    const signature = req.headers["x-twilio-signature"];
    const fullUrl = publicUrl + req.url.split("?")[0];
    const params = req.body || {};

    if (!signature || !validateSignature(twilioAuthToken, signature, fullUrl, params)) {
      reply.code(403).send("Invalid signature");
    }
  });

  app.post("/inbound-call", async (req, reply) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="wss://${escapeXml(wsHost)}/ws"
                       ttsProvider="ElevenLabs"
                       voice="${escapeXml(voiceId)}"
                       transcriptionProvider="Deepgram"
                       interruptible="true"
                       welcomeGreeting="${escapeXml(defaultWelcomeGreeting)}">
      <Parameter name="systemPrompt" value="${escapeXml(defaultSystemPrompt)}" />
    </ConversationRelay>
  </Connect>
</Response>`;
    reply.type("text/xml").send(twiml);
  });

  app.post("/outbound-twiml", async (req, reply) => {
    const callSid = req.body?.CallSid;
    const call = getCall(callSid);
    const systemPrompt = call?.systemPrompt || defaultSystemPrompt;
    const greeting = defaultWelcomeGreeting;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="wss://${escapeXml(wsHost)}/ws"
                       ttsProvider="ElevenLabs"
                       voice="${escapeXml(voiceId)}"
                       transcriptionProvider="Deepgram"
                       interruptible="true"
                       welcomeGreeting="${escapeXml(greeting)}">
      <Parameter name="systemPrompt" value="${escapeXml(systemPrompt)}" />
    </ConversationRelay>
  </Connect>
</Response>`;
    reply.type("text/xml").send(twiml);
  });

  const TERMINAL_STATUSES = ["completed", "failed", "busy", "no-answer", "canceled"];

  app.post("/call-status", async (req, reply) => {
    const { CallSid, CallStatus } = req.body;
    updateCall(CallSid, { status: CallStatus });
    if (TERMINAL_STATUSES.includes(CallStatus)) {
      const call = removeCall(CallSid);
      if (call) logCall({ ...call, endedAt: new Date().toISOString() }, dataDir);
    }
    reply.code(204).send();
  });

  // Conversation history per active WebSocket (keyed by callSid)
  const conversations = new Map();

  app.register(async function wsRoutes(fastify) {
    fastify.get("/ws", { websocket: true }, (socket, req) => {
      let callSid = null;
      let abortController = null;

      socket.on("message", async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === "setup") {
          callSid = msg.callSid;
          const systemPrompt = msg.customParameters?.systemPrompt || defaultSystemPrompt;
          conversations.set(callSid, [{ role: "system", content: systemPrompt }]);
          if (!getCall(callSid)) {
            addCall({ callSid, from: msg.from, to: msg.to, status: "in-progress", systemPrompt });
          }
        }

        if (msg.type === "prompt" && callSid) {
          const history = conversations.get(callSid);
          if (!history) return;
          history.push({ role: "user", content: msg.voicePrompt });

          abortController = new AbortController();
          let fullResponse = "";

          try {
            for await (const token of streamChat({
              messages: history,
              sessionKey: `voice:${callSid}`,
              apiUrl: openclawApiUrl,
              apiToken: openclawApiToken,
              signal: abortController.signal,
            })) {
              fullResponse += token;
              socket.send(JSON.stringify({ type: "text", token, last: false }));
            }
            socket.send(JSON.stringify({ type: "text", token: "", last: true }));
            history.push({ role: "assistant", content: fullResponse });
          } catch (err) {
            if (err.name !== "AbortError") {
              socket.send(JSON.stringify({
                type: "text",
                token: "I'm sorry, I encountered an error. Could you repeat that?",
                last: true,
              }));
            }
          }
          abortController = null;
        }

        if (msg.type === "interrupt") {
          if (abortController) abortController.abort();
        }
      });

      socket.on("close", () => {
        if (callSid) {
          conversations.delete(callSid);
          const call = removeCall(callSid);
          if (call) logCall({ ...call, endedAt: new Date().toISOString() }, dataDir);
        }
      });
    });
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/seif/projects/openclaw-twilio-voice && node --test test/server.test.mjs
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/server.mjs test/server.test.mjs
git commit -m "feat: add Fastify HTTP endpoints with Twilio webhook signature validation"
```

---

### Task 5: WebSocket ConversationRelay handler tests

**Files:**
- Modify: `test/server.test.mjs` (append WebSocket tests)

This task tests the WebSocket handler that was implemented in Task 4's `lib/server.mjs`. The implementation is already there — we just need to verify it works with integration tests.

- [ ] **Step 1: Add WebSocket tests to test/server.test.mjs**

Append to the end of `test/server.test.mjs`:

```javascript
import { mock } from "node:test";
import { WebSocket } from "ws";

describe("WebSocket /ws", () => {
  let port;
  let ws;

  beforeEach(async () => {
    // We need a real listening server for WebSocket tests
    // app is already created in the outer beforeEach
    const address = await app.listen({ port: 0 });
    port = new URL(address).port;
  });

  afterEach(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  });

  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function sendAndWait(ws, msg) {
    return new Promise((resolve) => {
      const messages = [];
      const handler = (raw) => {
        const parsed = JSON.parse(raw.toString());
        messages.push(parsed);
        if (parsed.last === true) {
          ws.removeListener("message", handler);
          resolve(messages);
        }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify(msg));
    });
  }

  it("handles setup event and registers call", async () => {
    await connect();
    ws.send(JSON.stringify({
      type: "setup",
      callSid: "CAWS1",
      from: "+1111",
      to: "+2222",
      customParameters: { systemPrompt: "Be friendly" },
    }));
    // Give it a moment to process
    await new Promise(r => setTimeout(r, 50));
    const { getCall } = await import("../lib/calls.mjs");
    const call = getCall("CAWS1");
    assert.equal(call.callSid, "CAWS1");
    assert.equal(call.systemPrompt, "Be friendly");
  });

  it("handles prompt event and streams response", async () => {
    // Mock fetch to return SSE stream
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

    await connect();

    // Setup first
    ws.send(JSON.stringify({
      type: "setup",
      callSid: "CAWS2",
      from: "+1111",
      to: "+2222",
      customParameters: {},
    }));
    await new Promise(r => setTimeout(r, 50));

    // Then prompt
    const responses = await sendAndWait(ws, {
      type: "prompt",
      voicePrompt: "Hello?",
    });

    // Should get: {token:"Yes", last:false}, {token:" indeed", last:false}, {token:"", last:true}
    assert.ok(responses.length >= 2);
    const tokens = responses.filter(r => r.token).map(r => r.token);
    assert.ok(tokens.includes("Yes"));
    assert.ok(tokens.includes(" indeed"));
    assert.equal(responses[responses.length - 1].last, true);
  });
});
```

Note: This test uses the `ws` package as a WebSocket client. Since we're running in Node 22, we could use the global `WebSocket`, but `ws` is already a transitive dependency of `@fastify/websocket` so it's available. However, the `ws` import may not work directly. If not, use the global `WebSocket` constructor instead:

Replace `import { WebSocket } from "ws";` with just using `WebSocket` (global in Node 22+). If that doesn't work, add `ws` as a dev dependency.

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd /home/seif/projects/openclaw-twilio-voice && node --test test/server.test.mjs
```

If `WebSocket` import fails, fix by either:
- Using global `WebSocket` (Node 22+)
- Or: `npm install --save-dev ws` and import from "ws"

Expected: All tests PASS (including the new WebSocket tests)

- [ ] **Step 3: Commit**

```bash
git add test/server.test.mjs
git commit -m "test: add WebSocket ConversationRelay integration tests"
```

---

### Task 6: MCP tools (lib/mcp.mjs)

**Files:**
- Create: `test/mcp.test.mjs`
- Create: `lib/mcp.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/mcp.test.mjs`:

```javascript
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { clearCalls, addCall, getCall, listActiveCalls } from "../lib/calls.mjs";
import { createMcpServer } from "../lib/mcp.mjs";

const CONFIG = {
  twilioSid: "ACtest123",
  twilioToken: "test-token",
  twilioFrom: "+15550001111",
  publicUrl: "https://voice.example.com",
  defaultSystemPrompt: "Default prompt",
};

let server;

beforeEach(() => {
  clearCalls();
  server = createMcpServer(CONFIG);
});

afterEach(() => {
  mock.restoreAll();
});

// Helper to call a tool on the server
async function callTool(name, args = {}) {
  // Access the CallToolRequest handler directly
  const handlers = server._requestHandlers;
  // Use the server's internal dispatch
  const result = await server.handleRequest({
    method: "tools/call",
    params: { name, arguments: args },
  });
  return result;
}

describe("MCP tool: make_call", () => {
  it("creates a call via Twilio and stores it", async () => {
    mock.method(globalThis, "fetch", async (url) => {
      if (url.includes("Calls.json")) {
        return {
          ok: true,
          json: async () => ({ sid: "CAnew1", status: "queued" }),
        };
      }
    });

    const result = await callTool("make_call", { to: "+15559999999", system_prompt: "Sell lemonade" });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("CAnew1"));

    const call = getCall("CAnew1");
    assert.equal(call.to, "+15559999999");
    assert.equal(call.systemPrompt, "Sell lemonade");
  });

  it("returns error on Twilio failure", async () => {
    mock.method(globalThis, "fetch", async () => {
      return {
        ok: true,
        json: async () => ({ error_code: 21211, error_message: "Invalid phone number" }),
      };
    });

    const result = await callTool("make_call", { to: "bad" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("Invalid phone number"));
  });
});

describe("MCP tool: hang_up", () => {
  it("ends a call via Twilio", async () => {
    addCall({ callSid: "CAhang1", from: "+1111", to: "+2222", status: "in-progress", systemPrompt: "" });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ sid: "CAhang1", status: "completed" }),
    }));

    const result = await callTool("hang_up", { call_sid: "CAhang1" });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("completed"));
  });
});

describe("MCP tool: get_call_status", () => {
  it("fetches call status from Twilio", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        sid: "CAstat1",
        status: "in-progress",
        duration: "45",
        from: "+1111",
        to: "+2222",
      }),
    }));

    const result = await callTool("get_call_status", { call_sid: "CAstat1" });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("in-progress"));
    assert.ok(result.content[0].text.includes("45"));
  });
});

describe("MCP tool: list_active_calls", () => {
  it("returns all active calls", async () => {
    addCall({ callSid: "CAlist1", from: "+1111", to: "+2222", status: "in-progress", systemPrompt: "" });
    addCall({ callSid: "CAlist2", from: "+3333", to: "+4444", status: "ringing", systemPrompt: "" });

    const result = await callTool("list_active_calls");
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("CAlist1"));
    assert.ok(result.content[0].text.includes("CAlist2"));
  });

  it("reports when no active calls", async () => {
    const result = await callTool("list_active_calls");
    assert.ok(result.content[0].text.toLowerCase().includes("no active"));
  });
});
```

**Note on the `callTool` helper:** The MCP SDK `Server` class doesn't expose a public `handleRequest` method for testing. The test helper needs to be adapted based on the actual SDK API. The approach above is a sketch — the implementer should check how the MCP SDK processes requests and either:
- Use the SDK's internal handler map directly
- Or create a mock transport and send tool-call requests through it

A practical alternative using a mock transport:

```javascript
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

let client;
let server;

beforeEach(async () => {
  clearCalls();
  server = createMcpServer(CONFIG);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  mock.restoreAll();
});

async function callTool(name, args = {}) {
  return client.callTool({ name, arguments: args });
}
```

Use whichever pattern the SDK supports. Check the `@modelcontextprotocol/sdk` package for `InMemoryTransport` or similar test utilities.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/seif/projects/openclaw-twilio-voice && node --test test/mcp.test.mjs
```

Expected: FAIL — `Cannot find module '../lib/mcp.mjs'`

- [ ] **Step 3: Write the implementation**

Create `lib/mcp.mjs`:

```javascript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { addCall, getCall, listActiveCalls } from "./calls.mjs";

export function createMcpServer(config) {
  const { twilioSid, twilioToken, twilioFrom, publicUrl, defaultSystemPrompt } = config;
  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
  const twilioBase = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}`;

  const server = new Server(
    { name: "openclaw-twilio-voice", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "make_call",
        description: "Make an outbound phone call. The AI agent will handle the conversation using the provided system prompt.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient phone number in E.164 format (e.g. +15551234567)" },
            system_prompt: { type: "string", description: "Instructions for how the AI should behave on this call" },
          },
          required: ["to"],
        },
      },
      {
        name: "hang_up",
        description: "End an active phone call.",
        inputSchema: {
          type: "object",
          properties: {
            call_sid: { type: "string", description: "The Twilio Call SID to hang up" },
          },
          required: ["call_sid"],
        },
      },
      {
        name: "get_call_status",
        description: "Get the current status of a phone call.",
        inputSchema: {
          type: "object",
          properties: {
            call_sid: { type: "string", description: "The Twilio Call SID to check" },
          },
          required: ["call_sid"],
        },
      },
      {
        name: "list_active_calls",
        description: "List all currently active phone calls.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;

    if (name === "make_call") {
      const { to, system_prompt } = req.params.arguments;
      try {
        const res = await fetch(`${twilioBase}/Calls.json`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: to,
            From: twilioFrom,
            Url: `${publicUrl}/outbound-twiml`,
            StatusCallback: `${publicUrl}/call-status`,
            StatusCallbackEvent: "initiated ringing answered completed",
          }),
        });
        const data = await res.json();
        if (data.error_code) {
          return { content: [{ type: "text", text: `Twilio error: ${data.error_message}` }], isError: true };
        }
        addCall({
          callSid: data.sid,
          from: twilioFrom,
          to,
          status: data.status,
          systemPrompt: system_prompt || defaultSystemPrompt || "",
        });
        return { content: [{ type: "text", text: `Call initiated to ${to} (sid: ${data.sid}, status: ${data.status})` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to make call: ${e.message}` }], isError: true };
      }
    }

    if (name === "hang_up") {
      const { call_sid } = req.params.arguments;
      try {
        const res = await fetch(`${twilioBase}/Calls/${call_sid}.json`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ Status: "completed" }),
        });
        const data = await res.json();
        return { content: [{ type: "text", text: `Call ${call_sid} ended (status: ${data.status})` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to hang up: ${e.message}` }], isError: true };
      }
    }

    if (name === "get_call_status") {
      const { call_sid } = req.params.arguments;
      try {
        const res = await fetch(`${twilioBase}/Calls/${call_sid}.json`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        const data = await res.json();
        return {
          content: [{
            type: "text",
            text: `Call ${data.sid}: status=${data.status}, duration=${data.duration}s, from=${data.from}, to=${data.to}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to get status: ${e.message}` }], isError: true };
      }
    }

    if (name === "list_active_calls") {
      const calls = listActiveCalls();
      if (!calls.length) {
        return { content: [{ type: "text", text: "No active calls." }] };
      }
      const formatted = calls.map(c =>
        `${c.callSid}: ${c.from} → ${c.to} (${c.status}, started ${c.startedAt})`
      ).join("\n");
      return { content: [{ type: "text", text: formatted }] };
    }

    return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
  });

  return server;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/seif/projects/openclaw-twilio-voice && node --test test/mcp.test.mjs
```

Expected: All tests PASS. If the `callTool` helper doesn't work with the SDK, adapt it per the note in Step 1.

- [ ] **Step 5: Commit**

```bash
git add lib/mcp.mjs test/mcp.test.mjs
git commit -m "feat: add MCP tools for make_call, hang_up, get_call_status, list_active_calls"
```

---

### Task 7: Entry point (index.mjs)

**Files:**
- Create: `index.mjs`

- [ ] **Step 1: Write index.mjs**

```javascript
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
```

- [ ] **Step 2: Run all tests to confirm nothing is broken**

```bash
cd /home/seif/projects/openclaw-twilio-voice && npm test
```

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add index.mjs
git commit -m "feat: add entry point wiring MCP server and Fastify webhook server"
```

---

### Task 8: README and GitHub repo

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

```markdown
# openclaw-twilio-voice

MCP server for AI-powered phone calls via Twilio ConversationRelay — built for OpenClaw and Claude Code.

Replaces OpenClaw's built-in voice-call plugin which has a [known EADDRINUSE bug](https://github.com/openclaw/openclaw/issues/57186). This standalone server avoids the port conflict entirely by running as a separate process.

## How it works

A single process runs two servers:

- **MCP server** (stdio) — exposes tools to your OpenClaw agent: `make_call`, `hang_up`, `get_call_status`, `list_active_calls`
- **Fastify HTTP+WebSocket server** — handles Twilio webhooks and ConversationRelay connections

When a call connects, Twilio's [ConversationRelay](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay) handles speech-to-text and text-to-speech (via ElevenLabs + Deepgram). Your server only deals with text — it forwards transcribed speech to OpenClaw's agent and streams the response back.

## Setup

### Prerequisites

- Node.js >= 22
- A Twilio account with a phone number
- An ElevenLabs account with a voice ID
- OpenClaw gateway running with Chat Completions endpoint enabled

### Enable OpenClaw Chat Completions

Add to `~/.openclaw/openclaw.json` under the `gateway` key:

```json
"http": {
  "endpoints": {
    "chatCompletions": { "enabled": true }
  }
}
```

Then restart the gateway.

### Install

```bash
git clone https://github.com/YOUR_USERNAME/openclaw-twilio-voice.git
cd openclaw-twilio-voice
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Configure Twilio

Point your Twilio phone number's voice webhook to:
```
POST https://your-public-url.com/inbound-call
```

### Run

```bash
node index.mjs
```

### Add to OpenClaw as MCP server

Add to `~/.openclaw/openclaw.json`:

```json
"mcpServers": {
  "twilio-voice": {
    "command": "node",
    "args": ["/path/to/openclaw-twilio-voice/index.mjs"],
    "env": {
      "TWILIO_ACCOUNT_SID": "ACxxx",
      "TWILIO_AUTH_TOKEN": "xxx",
      "TWILIO_FROM_NUMBER": "+15551234567",
      "ELEVENLABS_VOICE_ID": "xxx",
      "OPENCLAW_API_TOKEN": "xxx",
      "PUBLIC_URL": "https://voice.example.com"
    }
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `make_call` | Make an outbound call with optional system prompt |
| `hang_up` | End an active call by SID |
| `get_call_status` | Check call status, duration, participants |
| `list_active_calls` | List all in-progress calls |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TWILIO_ACCOUNT_SID` | yes | — | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | yes | — | Twilio auth token |
| `TWILIO_FROM_NUMBER` | yes | — | Your Twilio phone number |
| `ELEVENLABS_VOICE_ID` | yes | — | ElevenLabs voice for TTS |
| `OPENCLAW_API_TOKEN` | yes | — | OpenClaw gateway token |
| `PUBLIC_URL` | yes | — | Public URL for webhooks |
| `OPENCLAW_API_URL` | no | `http://127.0.0.1:18789` | OpenClaw gateway URL |
| `WEBHOOK_PORT` | no | `8080` | Fastify server port |
| `CALL_DATA_DIR` | no | `~/.openclaw-twilio-voice/` | Call log directory |
| `DEFAULT_SYSTEM_PROMPT` | no | (see .env.example) | System prompt for inbound calls |
| `DEFAULT_WELCOME_GREETING` | no | `Hello, how can I help you?` | Greeting when call connects |

## Testing

```bash
npm test
```

## License

MIT
```

- [ ] **Step 2: Run all tests one final time**

```bash
cd /home/seif/projects/openclaw-twilio-voice && npm test
```

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup and usage instructions"
```

- [ ] **Step 4: Create GitHub repo and push**

```bash
cd /home/seif/projects/openclaw-twilio-voice
gh repo create openclaw-twilio-voice --public --source=. --push
```

---

## Post-implementation checklist

After all tasks are complete, verify:

- [ ] `npm test` passes all tests
- [ ] `node index.mjs` starts without errors (with valid .env)
- [ ] GitHub repo is public and pushed
- [ ] README accurately describes the project
