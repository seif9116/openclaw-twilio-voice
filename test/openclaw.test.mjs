import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { streamChat } from "../lib/openclaw.mjs";

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
