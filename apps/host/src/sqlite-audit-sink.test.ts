import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAuditRecord } from "@george/protocol";
import { getAuditDatabasePath, SqliteAuditSink } from "./sqlite-audit-sink.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "george-audit-"));
  directories.push(directory);
  return join(directory, "audit.sqlite");
}

const event: AgentAuditRecord = {
  requestId: "request-1",
  conversationId: "conversation-1",
  channel: "desktop",
  operation: "agent.request",
  status: "completed",
  occurredAt: "2026-10-03T12:00:00.000Z",
  durationMs: 42,
  metadata: { providerId: "mock", prompt: "private prompt", token: "secret-token" }
};

describe("SqliteAuditSink", () => {
  it("writes safe audit fields and persists them after reopening the database", () => {
    const path = temporaryDatabase();
    const first = new SqliteAuditSink(path, () => "event-1");
    first.record(event);
    expect(first.recent()).toMatchObject([
      { eventId: "event-1", requestId: "request-1", resultStatus: "completed" }
    ]);
    first.close();

    const second = new SqliteAuditSink(path, () => "event-2");
    second.record({ ...event, requestId: "request-2" });
    expect(second.recent(500)).toHaveLength(2);
    second.close();

    const database = new Database(path, { readonly: true });
    const row = database
      .prepare("SELECT metadata_json FROM audit_events WHERE event_id = ?")
      .get("event-1") as { metadata_json: string };
    expect(row.metadata_json).toBe(JSON.stringify({ providerId: "mock" }));
    expect(database.prepare("SELECT version FROM schema_migrations").all()).toEqual([
      { version: 1 }
    ]);
    database.close();
  });

  it("uses the user's application data directory and bounds recent queries", () => {
    expect(getAuditDatabasePath({ LOCALAPPDATA: "C:\\Users\\sample\\AppData\\Local" })).toBe(
      "C:\\Users\\sample\\AppData\\Local\\George\\audit.sqlite"
    );
    const sink = new SqliteAuditSink(temporaryDatabase());
    expect(sink.recent(0)).toEqual([]);
    expect(sink.recent(10000)).toEqual([]);
    sink.close();
  });

  it("surfaces database errors to callers so tool execution can fail closed", () => {
    const sink = new SqliteAuditSink(temporaryDatabase());
    sink.close();
    expect(() => sink.record(event)).toThrow();
  });
});
