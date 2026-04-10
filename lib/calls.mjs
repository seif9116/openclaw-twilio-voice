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
