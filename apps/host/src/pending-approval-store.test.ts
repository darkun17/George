import { describe, expect, it } from "vitest";
import { InMemoryAuditSink } from "@george/core";
import { PendingApprovalStore } from "./pending-approval-store.js";

const input = {
  requestId: "request-1",
  conversationId: "conversation-1",
  channel: "desktop" as const,
  toolCallId: "provider-call-id",
  executionId: "execution-1",
  toolId: "test.high-risk",
  riskLevel: "HIGH" as const
};

describe("PendingApprovalStore", () => {
  it("keeps safe metadata in memory and resolves exactly once under concurrent approve calls", async () => {
    const audit = new InMemoryAuditSink();
    let finish!: () => void;
    let invocations = 0;
    const store = new PendingApprovalStore(audit, { createId: () => "george-approval-id" });
    const approval = store.create(input, async () => {
      invocations++;
      await new Promise<void>((resolve) => (finish = resolve));
      return {
        status: "completed",
        requestId: input.requestId,
        conversationId: input.conversationId,
        content: "done",
        receivedAt: "2026-10-03T12:00:00.000Z",
        completedAt: "2026-10-03T12:00:01.000Z",
        durationMs: 1000
      };
    });
    expect(approval).toMatchObject({ approvalId: "george-approval-id", status: "PENDING" });
    expect(JSON.stringify(store.list())).not.toContain("input");
    const first = store.approve("george-approval-id");
    const second = await store.approve("george-approval-id");
    expect(second).toEqual({ status: "already_resolved" });
    expect(invocations).toBe(1);
    finish();
    await expect(first).resolves.toMatchObject({
      status: "resolved",
      response: { status: "completed" }
    });
    expect(audit.records).toHaveLength(2);
  });

  it("allows the first concurrent decision to win and disposes a denied continuation", async () => {
    const store = new PendingApprovalStore(new InMemoryAuditSink());
    let invoked = 0;
    let disposed = 0;
    const approval = store.create(
      input,
      async () => {
        invoked++;
        return {
          status: "failed",
          requestId: "r",
          conversationId: "c",
          error: { code: "INTERNAL_ERROR", message: "failed" },
          receivedAt: "2026-10-03T12:00:00Z",
          completedAt: "2026-10-03T12:00:01Z",
          durationMs: 1
        };
      },
      () => disposed++
    );
    const [approved, denied] = await Promise.all([
      store.approve(approval!.approvalId),
      Promise.resolve(store.deny(approval!.approvalId))
    ]);
    expect([approved.status, denied.status]).toContain("resolved");
    expect(invoked).toBeLessThanOrEqual(1);
    expect(disposed).toBeLessThanOrEqual(1);
  });

  it("expires approvals and drops their continuation without allowing execution", async () => {
    const audit = new InMemoryAuditSink();
    let now = new Date("2026-10-03T12:00:00.000Z");
    let invoked = 0;
    let disposed = 0;
    const store = new PendingApprovalStore(audit, { ttlMs: 1000, clock: () => now });
    const approval = store.create(
      input,
      async () => {
        invoked++;
        throw new Error("must not run");
      },
      () => disposed++
    );
    now = new Date(now.getTime() + 2000);
    expect(store.list()).toMatchObject([{ status: "EXPIRED" }]);
    await expect(store.approve(approval!.approvalId)).resolves.toMatchObject({ status: "expired" });
    expect(invoked).toBe(0);
    expect(disposed).toBe(1);
    expect(
      audit.records.map((record) =>
        record.operation === "approval.decision" ? record.decision : "other"
      )
    ).toEqual(["requested", "expired"]);
    store.clear();
  });
});
