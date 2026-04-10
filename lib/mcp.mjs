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
