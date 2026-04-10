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
git clone https://github.com/seifeldin7/openclaw-twilio-voice.git
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
