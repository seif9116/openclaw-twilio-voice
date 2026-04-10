import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
  // Strip the huge system prompt from the metadata log — keep only a short marker
  const { systemPrompt, ...rest } = entry;
  const logPath = join(dataDir, "calls.jsonl");
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...rest,
    systemPromptChars: systemPrompt?.length || 0,
  }) + "\n";
  try { appendFileSync(logPath, line); } catch {}
}

export function saveTranscript(callSid, transcript, dataDir) {
  const transcriptDir = join(dataDir, "transcripts");
  try {
    mkdirSync(transcriptDir, { recursive: true });
    const path = join(transcriptDir, `${callSid}.json`);
    writeFileSync(path, JSON.stringify(transcript, null, 2));
  } catch {}
}
