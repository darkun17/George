import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { AuditRecord } from "@george/protocol";
import { getAppDataDir } from "./app-data.js";

export interface SafeAuditEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly requestId: string | null;
  readonly conversationId: string | null;
  readonly executionId: string | null;
  readonly channel: string | null;
  readonly toolId: string | null;
  readonly toolCallId: string | null;
  readonly riskLevel: string | null;
  readonly policyDecision: string | null;
  readonly approvalId: string | null;
  readonly approvalStatus: string | null;
  readonly resultStatus: string;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
}

export function getAuditDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(getAppDataDir(environment), "audit.sqlite");
}

export class SqliteAuditSink {
  readonly #database: Database.Database;
  readonly #insert: Database.Statement;
  readonly #createId: () => string;

  constructor(path: string, createId: () => string = randomUUID) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new Database(path);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = FULL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    this.#database.transaction(() => {
      const version = this.#database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number | null };
      if ((version.version ?? 0) < 1) {
        this.#database.exec(`
          CREATE TABLE audit_events (
            event_id TEXT PRIMARY KEY,
            occurred_at TEXT NOT NULL,
            event_type TEXT NOT NULL,
            operation TEXT NOT NULL,
            request_id TEXT,
            conversation_id TEXT,
            execution_id TEXT,
            channel TEXT,
            tool_id TEXT,
            tool_call_id TEXT,
            risk_level TEXT,
            policy_decision TEXT,
            approval_id TEXT,
            approval_status TEXT,
            result_status TEXT NOT NULL,
            duration_ms INTEGER,
            error_code TEXT,
            metadata_json TEXT NOT NULL
          );
          CREATE INDEX audit_events_recent ON audit_events(occurred_at DESC, event_id);
          INSERT INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
        `);
      }
    })();
    this.#insert = this.#database.prepare(`
      INSERT INTO audit_events (
        event_id, occurred_at, event_type, operation, request_id, conversation_id, execution_id, channel,
        tool_id, tool_call_id, risk_level, policy_decision, approval_id, approval_status,
        result_status, duration_ms, error_code, metadata_json
      ) VALUES (
        @eventId, @occurredAt, @eventType, @operation, @requestId, @conversationId, @executionId, @channel,
        @toolId, @toolCallId, @riskLevel, @policyDecision, @approvalId, @approvalStatus,
        @resultStatus, @durationMs, @errorCode, @metadataJson
      )
    `);
    this.#createId = createId;
  }

  record(record: AuditRecord): void {
    const common = {
      eventId: this.#createId(),
      occurredAt: record.occurredAt,
      operation: record.operation,
      requestId: record.requestId,
      conversationId: record.conversationId,
      channel: record.channel,
      metadataJson: JSON.stringify(this.#safeMetadata(record.metadata))
    };
    let row: Omit<typeof common, never> & {
      readonly eventType: string;
      readonly executionId: string | null;
      readonly toolId: string | null;
      readonly toolCallId: string | null;
      readonly riskLevel: string | null;
      readonly policyDecision: string | null;
      readonly approvalId: string | null;
      readonly approvalStatus: string | null;
      readonly resultStatus: string;
      readonly durationMs: number | null;
      readonly errorCode: string | null;
    };
    switch (record.operation) {
      case "approval.decision":
        row = {
          ...common,
          eventType: "approval",
          executionId: record.executionId,
          toolId: record.toolId,
          toolCallId: record.toolCallId,
          riskLevel: record.riskLevel,
          policyDecision: null,
          approvalId: record.approvalId,
          approvalStatus: record.decision,
          resultStatus: record.decision,
          durationMs: null,
          errorCode: null
        };
        break;
      case "tool.execution":
        row = {
          ...common,
          eventType: "tool",
          executionId: record.executionId,
          toolId: record.toolId,
          toolCallId: record.toolCallId ?? null,
          riskLevel: record.riskLevel ?? null,
          policyDecision: record.policyOutcome ?? null,
          approvalId: record.approvalId ?? null,
          approvalStatus: record.approvalStatus ?? null,
          resultStatus: record.status,
          durationMs: record.durationMs,
          errorCode: record.errorCode ?? null
        };
        break;
      case "agent.request":
        row = {
          ...common,
          eventType: "agent",
          executionId: null,
          toolId: null,
          toolCallId: null,
          riskLevel: null,
          policyDecision: null,
          approvalId: null,
          approvalStatus: null,
          resultStatus: record.status,
          durationMs: record.durationMs ?? null,
          errorCode: record.errorCode ?? null
        };
        break;
    }
    this.#insert.run(row);
  }

  recent(limit = 50): readonly SafeAuditEvent[] {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
    return this.#database
      .prepare(
        `
      SELECT event_id AS eventId, occurred_at AS occurredAt, event_type AS eventType,
        request_id AS requestId, conversation_id AS conversationId, execution_id AS executionId, channel, tool_id AS toolId,
        tool_call_id AS toolCallId, risk_level AS riskLevel, policy_decision AS policyDecision,
        approval_id AS approvalId, approval_status AS approvalStatus, result_status AS resultStatus,
        duration_ms AS durationMs, error_code AS errorCode
      FROM audit_events ORDER BY occurred_at DESC, event_id DESC LIMIT ?
    `
      )
      .all(boundedLimit) as SafeAuditEvent[];
  }

  close(): void {
    this.#database.close();
  }

  #safeMetadata(
    metadata: Readonly<Record<string, string | number | boolean>>
  ): Record<string, string | number | boolean> {
    const safe: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (/^(providerId|errorCode|status|count)$/.test(key)) safe[key] = value;
    }
    return safe;
  }
}
