import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import { createHmac } from "node:crypto";
import { getCall, updateCall, removeCall, addCall, logCall, saveTranscript } from "./calls.mjs";
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
    llmApiUrl, llmApiToken, llmModel, dataDir, twilioAuthToken,
  } = config;

  const app = Fastify({ logger: true });
  app.register(fastifyFormBody);
  app.register(fastifyWebsocket);

  const wsHost = new URL(publicUrl).host;

  // Twilio signature validation hook for non-WebSocket routes
  app.addHook("preHandler", async (req, reply) => {
    if (req.headers.upgrade === "websocket") return;
    const pathOnly = req.url.split("?")[0];
    const twilioRoutes = ["/inbound-call", "/outbound-twiml", "/call-status"];
    if (!twilioRoutes.includes(pathOnly)) return;

    const signature = req.headers["x-twilio-signature"];
    // Twilio computes signature over the FULL URL including query string
    const fullUrl = publicUrl + req.url;
    const params = req.body || {};

    req.log.info({ fullUrl, hasSignature: !!signature }, "Twilio signature check");

    if (!signature || !validateSignature(twilioAuthToken, signature, fullUrl, params)) {
      req.log.warn({ fullUrl, signature }, "Invalid Twilio signature — rejecting");
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
    const reason = req.query?.reason || call?.reason || "";
    const customGreeting = req.query?.greeting || call?.greeting || "";

    // For outbound calls, augment the system prompt so the AI knows it's calling
    const outboundContext = `\n\n# THIS IS AN OUTBOUND CALL YOU INITIATED
You are calling your human (Seif) right now — they did not call you, you called them.
${reason ? `Reason for calling: ${reason}\n` : ""}

# Spam Screening (Apple, Google, etc.)
The recipient may have a call screening system (Apple Live Voicemail, Google Call Screen, etc.) that intercepts the call BEFORE it reaches them. This screen will typically ask questions like "who is this?" or "why are you calling?" — you MUST answer these clearly and naturally, just like a human caller would. Something like: "Hi, this is Jessica, I'm Seif's AI assistant calling to check in on him." Answer the screening question directly. Do NOT ignore it or stay silent.

Once the screen passes you through, Seif will pick up. Continue the conversation naturally from there.

# Starting the call
Lead immediately with a clear self-introduction and reason. Do not wait to be asked. Speak naturally like a human caller.`;

    const baseSystemPrompt = call?.systemPrompt || defaultSystemPrompt;
    const systemPrompt = baseSystemPrompt + outboundContext;

    // Use a natural outbound greeting that also satisfies call screeners
    const greeting = customGreeting || "Hi, this is Jessica, Seif's AI assistant. I'm calling to check in with him.";

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
      console.error("[ws] ConversationRelay connected");

      socket.on("message", async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        console.error(`[ws] ${msg.type}`, msg.type === "prompt" ? msg.voicePrompt : "");

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

          // Abort any in-flight request before starting a new one
          if (abortController) {
            console.error(`[ws] aborting previous request`);
            abortController.abort();
          }

          const localController = new AbortController();
          abortController = localController;
          let fullResponse = "";

          console.error(`[ws] calling LLM: ${llmApiUrl} model=${llmModel}`);

          try {
            let tokenCount = 0;
            for await (const token of streamChat({
              messages: history,
              apiUrl: llmApiUrl,
              apiToken: llmApiToken,
              model: llmModel,
              signal: localController.signal,
            })) {
              tokenCount++;
              fullResponse += token;
              socket.send(JSON.stringify({ type: "text", token, last: false }));
              if (tokenCount === 1) console.error(`[ws] first token received: "${token}"`);
            }
            socket.send(JSON.stringify({ type: "text", token: "", last: true }));
            console.error(`[ws] response complete: ${tokenCount} tokens, ${fullResponse.length} chars`);
            history.push({ role: "assistant", content: fullResponse });
          } catch (err) {
            console.error(`[ws] streamChat error: ${err.name}: ${err.message}`);
            if (err.name !== "AbortError") {
              socket.send(JSON.stringify({
                type: "text",
                token: "I'm sorry, I encountered an error. Could you repeat that?",
                last: true,
              }));
            }
          }
          // Only clear if we're still the active controller
          if (abortController === localController) abortController = null;
        }

        if (msg.type === "interrupt") {
          if (abortController) abortController.abort();
        }
      });

      socket.on("close", () => {
        if (callSid) {
          const history = conversations.get(callSid);
          if (history) {
            // Save transcript (excluding the system message, which is huge and constant)
            const messages = history.filter(m => m.role !== "system");
            if (messages.length > 0) {
              saveTranscript(callSid, {
                callSid,
                endedAt: new Date().toISOString(),
                messages,
              }, dataDir);
              console.error(`[ws] saved transcript: ${messages.length} messages`);
            }
          }
          conversations.delete(callSid);
          const call = removeCall(callSid);
          if (call) logCall({ ...call, endedAt: new Date().toISOString() }, dataDir);
        }
      });
    });
  });

  return app;
}
