import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { addCall, clearCalls, getCall, listActiveCalls } from "../lib/calls.mjs";
import { createMcpServer } from "../lib/mcp.mjs";

const CONFIG = {
  twilioSid: "AC_test_sid",
  twilioToken: "test_token_secret",
  twilioFrom: "+15550001111",
  publicUrl: "https://voice.example.com",
  defaultSystemPrompt: "You are a helpful assistant.",
};

let client;
let clientTransport;
let serverTransport;

async function setup() {
  const server = createMcpServer(CONFIG);
  [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}

beforeEach(async () => {
  clearCalls();
  await setup();
});

afterEach(async () => {
  mock.restoreAll();
  await clientTransport.close();
});

describe("list tools", () => {
  it("returns all 4 tools with correct names", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, ["get_call_status", "hang_up", "list_active_calls", "make_call"]);
  });
});

describe("make_call", () => {
  it("initiates a call and stores it", async () => {
    mock.method(globalThis, "fetch", async () => ({
      json: async () => ({ sid: "CAnew1", status: "queued" }),
    }));

    const result = await client.callTool({
      name: "make_call",
      arguments: { to: "+15559998888", system_prompt: "Be friendly" },
    });

    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.includes("CAnew1"));
    assert.ok(result.content[0].text.includes("queued"));

    // Verify call was stored
    const stored = getCall("CAnew1");
    assert.ok(stored);
    assert.equal(stored.to, "+15559998888");
    assert.equal(stored.systemPrompt, "Be friendly");
    assert.equal(stored.from, CONFIG.twilioFrom);
  });

  it("uses default system prompt when none provided", async () => {
    mock.method(globalThis, "fetch", async () => ({
      json: async () => ({ sid: "CAnew2", status: "queued" }),
    }));

    await client.callTool({
      name: "make_call",
      arguments: { to: "+15559998888" },
    });

    const stored = getCall("CAnew2");
    assert.equal(stored.systemPrompt, CONFIG.defaultSystemPrompt);
  });

  it("returns error when Twilio reports an error", async () => {
    mock.method(globalThis, "fetch", async () => ({
      json: async () => ({ error_code: 21211, error_message: "Invalid phone number" }),
    }));

    const result = await client.callTool({
      name: "make_call",
      arguments: { to: "+bad" },
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("Invalid phone number"));
  });

  it("returns error when fetch throws", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Network down");
    });

    const result = await client.callTool({
      name: "make_call",
      arguments: { to: "+15559998888" },
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("Network down"));
  });
});

describe("hang_up", () => {
  it("ends an active call", async () => {
    addCall({ callSid: "CAhang1", from: "+1111", to: "+2222", status: "in-progress", systemPrompt: "" });

    mock.method(globalThis, "fetch", async () => ({
      json: async () => ({ sid: "CAhang1", status: "completed" }),
    }));

    const result = await client.callTool({
      name: "hang_up",
      arguments: { call_sid: "CAhang1" },
    });

    assert.ok(result.content[0].text.includes("CAhang1"));
    assert.ok(result.content[0].text.includes("completed"));
  });

  it("returns error when fetch throws", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("API error");
    });

    const result = await client.callTool({
      name: "hang_up",
      arguments: { call_sid: "CAfail" },
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("API error"));
  });
});

describe("get_call_status", () => {
  it("returns call details from Twilio", async () => {
    mock.method(globalThis, "fetch", async () => ({
      json: async () => ({
        sid: "CAstatus1",
        status: "in-progress",
        duration: "45",
        from: "+15550001111",
        to: "+15559998888",
      }),
    }));

    const result = await client.callTool({
      name: "get_call_status",
      arguments: { call_sid: "CAstatus1" },
    });

    const text = result.content[0].text;
    assert.ok(text.includes("CAstatus1"));
    assert.ok(text.includes("in-progress"));
    assert.ok(text.includes("45"));
    assert.ok(text.includes("+15550001111"));
    assert.ok(text.includes("+15559998888"));
  });

  it("returns error when fetch throws", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Timeout");
    });

    const result = await client.callTool({
      name: "get_call_status",
      arguments: { call_sid: "CAfail" },
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("Timeout"));
  });
});

describe("list_active_calls", () => {
  it("lists active calls", async () => {
    addCall({ callSid: "CA_a", from: "+1111", to: "+2222", status: "in-progress", systemPrompt: "" });
    addCall({ callSid: "CA_b", from: "+3333", to: "+4444", status: "ringing", systemPrompt: "" });

    const result = await client.callTool({
      name: "list_active_calls",
      arguments: {},
    });

    const text = result.content[0].text;
    assert.ok(text.includes("CA_a"));
    assert.ok(text.includes("CA_b"));
    assert.ok(text.includes("+1111"));
    assert.ok(text.includes("+4444"));
  });

  it("returns empty message when no calls", async () => {
    const result = await client.callTool({
      name: "list_active_calls",
      arguments: {},
    });

    assert.equal(result.content[0].text, "No active calls.");
  });
});
