import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addCall, getCall, updateCall, removeCall,
  listActiveCalls, clearCalls, logCall,
} from "../lib/calls.mjs";

const TMP_DIR = join(import.meta.dirname, ".tmp-calls-test");

beforeEach(() => {
  clearCalls();
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("addCall", () => {
  it("stores a call and returns it with a startedAt timestamp", () => {
    const call = addCall({ callSid: "CA1", from: "+1111", to: "+2222", status: "queued", systemPrompt: "Be nice" });
    assert.equal(call.callSid, "CA1");
    assert.equal(call.from, "+1111");
    assert.equal(call.to, "+2222");
    assert.equal(call.status, "queued");
    assert.equal(call.systemPrompt, "Be nice");
    assert.ok(call.startedAt);
  });
});

describe("getCall", () => {
  it("returns stored call by SID", () => {
    addCall({ callSid: "CA2", from: "+1111", to: "+2222", status: "ringing", systemPrompt: "" });
    const call = getCall("CA2");
    assert.equal(call.callSid, "CA2");
  });

  it("returns null for unknown SID", () => {
    assert.equal(getCall("UNKNOWN"), null);
  });
});

describe("updateCall", () => {
  it("merges updates into existing call", () => {
    addCall({ callSid: "CA3", from: "+1111", to: "+2222", status: "queued", systemPrompt: "" });
    const updated = updateCall("CA3", { status: "in-progress" });
    assert.equal(updated.status, "in-progress");
    assert.equal(updated.from, "+1111");
  });

  it("returns null for unknown SID", () => {
    assert.equal(updateCall("NOPE", { status: "x" }), null);
  });
});

describe("removeCall", () => {
  it("removes and returns the call", () => {
    addCall({ callSid: "CA4", from: "+1111", to: "+2222", status: "in-progress", systemPrompt: "" });
    const removed = removeCall("CA4");
    assert.equal(removed.callSid, "CA4");
    assert.equal(getCall("CA4"), null);
  });

  it("returns null for unknown SID", () => {
    assert.equal(removeCall("NOPE"), null);
  });
});

describe("listActiveCalls", () => {
  it("returns all active calls", () => {
    addCall({ callSid: "CA5", from: "+1111", to: "+2222", status: "in-progress", systemPrompt: "" });
    addCall({ callSid: "CA6", from: "+3333", to: "+4444", status: "ringing", systemPrompt: "" });
    const list = listActiveCalls();
    assert.equal(list.length, 2);
    assert.ok(list.find(c => c.callSid === "CA5"));
    assert.ok(list.find(c => c.callSid === "CA6"));
  });

  it("returns empty array when no calls", () => {
    assert.deepEqual(listActiveCalls(), []);
  });
});

describe("logCall", () => {
  it("appends a JSONL entry to calls.jsonl", () => {
    logCall({ callSid: "CA7", from: "+1111", to: "+2222", status: "completed" }, TMP_DIR);
    const raw = readFileSync(join(TMP_DIR, "calls.jsonl"), "utf8").trim();
    const entry = JSON.parse(raw);
    assert.equal(entry.callSid, "CA7");
    assert.equal(entry.status, "completed");
    assert.ok(entry.ts);
  });

  it("appends multiple entries", () => {
    logCall({ callSid: "CA8", status: "completed" }, TMP_DIR);
    logCall({ callSid: "CA9", status: "failed" }, TMP_DIR);
    const lines = readFileSync(join(TMP_DIR, "calls.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  });
});
