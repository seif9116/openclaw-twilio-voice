import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { addCall, getCall, listActiveCalls } from "./calls.mjs";

export function createMcpServer(config) {
  const { twilioSid, twilioToken, twilioFrom, publicUrl, defaultSystemPrompt, dataDir } = config;
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
        description: "Make an outbound phone call. You (Jessica) will be the one on the call — provide a reason so you know why you called once the person picks up.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient phone number in E.164 format (e.g. +15551234567)" },
            reason: { type: "string", description: "Why you're calling — this context will be given to you when the call connects so you know what to say. Be specific." },
            greeting: { type: "string", description: "Optional custom greeting to say when the call connects. Defaults to 'Hi, this is Jessica, Seif's AI assistant.'" },
          },
          required: ["to", "reason"],
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
      {
        name: "list_recent_calls",
        description: "List recent completed phone calls with their metadata (from, to, duration, etc.). Use this to see what calls happened recently.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max number of calls to return (default 10)" },
          },
        },
      },
      {
        name: "get_call_transcript",
        description: "Read the full conversation transcript of a past phone call by its Call SID. Use this to recall what was said on a call.",
        inputSchema: {
          type: "object",
          properties: {
            call_sid: { type: "string", description: "The Twilio Call SID to fetch the transcript for" },
          },
          required: ["call_sid"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;

    if (name === "make_call") {
      const { to, reason, greeting } = req.params.arguments;
      try {
        // Encode reason in the URL so the webhook server (separate process) can read it
        const twimlUrl = new URL(`${publicUrl}/outbound-twiml`);
        if (reason) twimlUrl.searchParams.set("reason", reason);
        if (greeting) twimlUrl.searchParams.set("greeting", greeting);

        const res = await fetch(`${twilioBase}/Calls.json`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: to,
            From: twilioFrom,
            Url: twimlUrl.toString(),
            StatusCallback: `${publicUrl}/call-status`,
            StatusCallbackEvent: "initiated ringing answered completed",
          }),
        });
        const data = await res.json();
        if (data.error_code) {
          return { content: [{ type: "text", text: `Twilio error: ${data.error_message}` }], isError: true };
        }
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

    if (name === "list_recent_calls") {
      const { limit = 10 } = req.params.arguments || {};
      const logPath = join(dataDir, "calls.jsonl");
      if (!existsSync(logPath)) {
        return { content: [{ type: "text", text: "No call history yet." }] };
      }
      try {
        const raw = readFileSync(logPath, "utf8").trim();
        if (!raw) return { content: [{ type: "text", text: "No call history yet." }] };
        const entries = raw.split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
        const recent = entries.slice(-limit).reverse();
        if (!recent.length) return { content: [{ type: "text", text: "No call history yet." }] };
        const formatted = recent.map(c =>
          `${c.callSid}\n  ${c.from} → ${c.to}\n  status: ${c.status}, started: ${c.startedAt}, ended: ${c.endedAt || "?"}`
        ).join("\n\n");
        return { content: [{ type: "text", text: formatted }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to read call history: ${e.message}` }], isError: true };
      }
    }

    if (name === "get_call_transcript") {
      const { call_sid } = req.params.arguments;
      const transcriptPath = join(dataDir, "transcripts", `${call_sid}.json`);
      if (!existsSync(transcriptPath)) {
        return { content: [{ type: "text", text: `No transcript found for call ${call_sid}. It may have had no conversation, or the transcript file doesn't exist.` }] };
      }
      try {
        const data = JSON.parse(readFileSync(transcriptPath, "utf8"));
        if (!data.messages?.length) {
          return { content: [{ type: "text", text: `Call ${call_sid} had no messages.` }] };
        }
        const formatted = data.messages.map(m => {
          const role = m.role === "user" ? "Other party" : "Jessica";
          return `${role}: ${m.content}`;
        }).join("\n");
        return {
          content: [{
            type: "text",
            text: `Transcript of ${call_sid} (ended ${data.endedAt}):\n\n${formatted}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to read transcript: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
  });

  return server;
}
