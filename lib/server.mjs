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
    if (req.headers.upgrade === "websocket") return;
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

  // Conversation history per active WebSocket
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
