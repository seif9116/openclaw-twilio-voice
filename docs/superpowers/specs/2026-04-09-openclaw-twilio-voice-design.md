# openclaw-twilio-voice Design Spec

## Problem

OpenClaw's built-in voice-call plugin has a fundamental architectural bug: the CLI and agent tool each try to start their own webhook server on the same port the gateway already owns, causing EADDRINUSE crashes. There are 7+ open issues and no merged fix. We need a standalone replacement that handles voice calling reliably.

## Solution

A single-process Node.js application that runs both an MCP server (stdio, for OpenClaw agent tools) and a Fastify HTTP+WebSocket server (for Twilio ConversationRelay). Uses the OpenClaw Chat Completions API to route conversations through the OpenClaw agent.

## Architecture

```
OpenClaw Agent
    | (MCP stdio)
MCP Tools: make_call, hang_up, get_call_status, list_active_calls
    | (Twilio REST API)
Twilio
    | (HTTP webhook + WebSocket)
Fastify Server (WEBHOOK_PORT, default 8080)
    | (ConversationRelay text-only WebSocket)
WebSocket Handler
    | (HTTP SSE streaming)
OpenClaw Chat Completions API (localhost:18789)
    |
Agent response streamed back as speech
```

### Outbound call flow

1. Agent calls `make_call` MCP tool with `to` number and optional `system_prompt`
2. MCP handler calls Twilio REST API to create call, pointing TwiML URL at `PUBLIC_URL/outbound-twiml?callSid={sid}`
3. Callee picks up, Twilio hits `/outbound-twiml` webhook
4. Webhook returns TwiML with `<Connect><ConversationRelay url="wss://PUBLIC_URL/ws" .../>` and custom parameters (system_prompt, callSid)
5. Twilio opens WebSocket to our `/ws` endpoint
6. ConversationRelay handles STT/TTS; our server handles text conversation via OpenClaw

### Inbound call flow

1. Twilio receives call on the configured number, hits `PUBLIC_URL/inbound-call` webhook
2. Webhook returns TwiML with `<Connect><ConversationRelay url="wss://PUBLIC_URL/ws" .../>` and default system prompt
3. Same WebSocket conversation flow as outbound

## MCP Tools

### `make_call`
- **Params**: `to` (string, E.164 phone number, required), `system_prompt` (string, optional instructions for the AI on this call)
- **Behavior**: Creates outbound call via Twilio REST API. Stores call metadata in memory and appends to `calls.jsonl`. Returns call SID and initial status.

### `hang_up`
- **Params**: `call_sid` (string, required)
- **Behavior**: Updates the Twilio call to status "completed" via REST API. Cleans up in-memory state.

### `get_call_status`
- **Params**: `call_sid` (string, required)
- **Behavior**: Fetches current call status from Twilio API. Returns status, duration, from/to numbers.

### `list_active_calls`
- **Params**: none
- **Behavior**: Returns all calls currently tracked in memory with their status, from/to, and start time.

## WebSocket Conversation Handler

Event handling for ConversationRelay WebSocket connections:

### `setup`
- Twilio sends `callSid`, `from`, `to`, `customParameters`
- Create OpenClaw session with key `voice:{callSid}`
- Extract `system_prompt` from customParameters if present (outbound calls)
- Store session in active calls map

### `prompt`
- Twilio sends `voicePrompt` (transcribed caller speech)
- Forward to OpenClaw Chat Completions API with `stream: true`
- Use `x-openclaw-session-key: voice:{callSid}` for session continuity
- Stream tokens back to Twilio: `{type: "text", token: "...", last: false}` per chunk, `last: true` on final chunk

### `interrupt`
- Caller interrupted AI mid-speech
- Log `utteranceUntilInterrupt` for context
- Abort in-flight OpenClaw request if possible (AbortController)

### `dtmf`
- Keypad press received
- Log the digit, no special handling for now

### Connection close
- Clean up in-memory call state
- Log call summary to `calls.jsonl` with duration, from/to, timestamp

## HTTP Endpoints

### `POST /inbound-call`
- Twilio webhook for incoming calls
- Returns TwiML:
  ```xml
  <Response>
    <Connect>
      <ConversationRelay url="wss://{PUBLIC_URL}/ws"
                         ttsProvider="ElevenLabs"
                         voice="{ELEVENLABS_VOICE_ID}"
                         transcriptionProvider="Deepgram"
                         interruptible="true"
                         welcomeGreeting="Hello, how can I help you?" />
    </Connect>
  </Response>
  ```

### `POST /outbound-twiml`
- Called by Twilio when outbound callee picks up
- Reads `callSid` from query params, looks up stored system_prompt
- Returns TwiML with ConversationRelay config and custom parameters

### `POST /call-status`
- Status callback webhook for call lifecycle events
- Updates in-memory call state and logs transitions

## ConversationRelay Configuration

- **ttsProvider**: ElevenLabs (using existing voice ID `cgSgspJ2msm6clMCkdW9`)
- **transcriptionProvider**: Deepgram (reliable, low latency)
- **interruptible**: true (caller can interrupt AI mid-speech)
- **welcomeGreeting**: Configurable per call; defaults to "Hello, how can I help you?"

## OpenClaw Integration

Uses the OpenAI-compatible Chat Completions endpoint on the OpenClaw gateway:

```
POST http://127.0.0.1:18789/v1/chat/completions
Authorization: Bearer {OPENCLAW_API_TOKEN}
x-openclaw-session-key: voice:{callSid}

{
  "model": "openclaw/main",
  "stream": true,
  "messages": [
    {"role": "system", "content": "{system_prompt}"},
    {"role": "user", "content": "{voicePrompt}"}
  ]
}
```

Response is SSE with `data: {json}` lines, ending with `data: [DONE]`.

**Prerequisite**: The Chat Completions endpoint must be enabled in `~/.openclaw/openclaw.json`:
```json
"gateway": {
  "http": {
    "endpoints": {
      "chatCompletions": { "enabled": true }
    }
  }
}
```

## Configuration

All via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TWILIO_ACCOUNT_SID` | yes | - | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | yes | - | Twilio auth token |
| `TWILIO_FROM_NUMBER` | yes | - | Twilio phone number (E.164) |
| `ELEVENLABS_VOICE_ID` | yes | - | ElevenLabs voice ID for TTS |
| `OPENCLAW_API_URL` | no | `http://127.0.0.1:18789` | OpenClaw gateway URL |
| `OPENCLAW_API_TOKEN` | yes | - | OpenClaw gateway auth token |
| `WEBHOOK_PORT` | no | `8080` | Port for Fastify HTTP/WS server |
| `PUBLIC_URL` | yes | - | Public URL for Twilio webhooks (e.g. `https://voice.seifeldin.ca`) |
| `CALL_DATA_DIR` | no | `~/.openclaw-twilio-voice/` | Directory for call logs |
| `DEFAULT_SYSTEM_PROMPT` | no | `"You are a helpful voice assistant. Be concise — the caller is listening, not reading."` | System prompt for inbound calls |
| `DEFAULT_WELCOME_GREETING` | no | `"Hello, how can I help you?"` | ConversationRelay welcome greeting for inbound calls |

## Project Structure

```
openclaw-twilio-voice/
├── index.mjs              # Entry point: starts MCP + Fastify servers
├── lib/
│   ├── mcp.mjs            # MCP tool definitions and handlers
│   ├── server.mjs         # Fastify HTTP routes + WebSocket handler
│   ├── calls.mjs          # In-memory call state + JSONL logging
│   └── openclaw.mjs       # OpenClaw Chat Completions streaming client
├── test/
│   ├── mcp.test.mjs       # MCP tool handler tests
│   ├── server.test.mjs    # HTTP endpoint + WebSocket integration tests
│   └── calls.test.mjs     # Call state management tests
├── package.json
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework (matches SMS server)
- `fastify` — HTTP server
- `@fastify/websocket` — WebSocket support for Fastify
- `@fastify/formbody` — Parse Twilio's URL-encoded webhook bodies
- `twilio` — Twilio Node.js SDK for REST API calls and webhook signature validation

Dev dependencies:
- None (using `node:test` + `node:assert`)

## Testing Strategy

Using `node:test` and `node:assert` (zero dev dependencies).

### Unit tests (`test/mcp.test.mjs`)
- Each MCP tool handler tested with mocked Twilio API responses
- Verify correct Twilio API calls for make_call, hang_up, get_call_status
- Verify error handling for invalid inputs (bad phone number, unknown call SID)

### Unit tests (`test/calls.test.mjs`)
- Call state management: add, update, remove, list active calls
- JSONL logging: verify entries are written correctly
- Cleanup on call end

### Integration tests (`test/server.test.mjs`)
- Spin up Fastify server on a random port
- Test `/inbound-call` returns valid TwiML with correct ConversationRelay config
- Test `/outbound-twiml` returns TwiML with custom parameters
- Test `/call-status` updates call state correctly
- Simulate ConversationRelay WebSocket connection:
  - Send `setup` message, verify session creation
  - Send `prompt` message with mocked OpenClaw API, verify streamed response
  - Send `interrupt` message, verify cleanup
  - Close connection, verify call logged

### Webhook signature validation
- Verify requests without valid `X-Twilio-Signature` are rejected
- Verify valid signatures pass through

## References

- [Twilio ConversationRelay TwiML](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay)
- [Twilio ConversationRelay WebSocket Messages](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages)
- [OpenClaw Chat Completions API](https://docs.openclaw.ai/gateway/openai-http-api)
- [Simon Willison: The Perfect Commit](https://simonwillison.net/2022/Oct/29/the-perfect-commit/) — each commit bundles implementation + tests + docs + issue link
- [Simon Willison: Documentation Unit Tests](https://simonwillison.net/2018/Jul/28/documentation-unit-tests/) — introspection-based tests that verify documentation coverage
