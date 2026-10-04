import { Component, inject, signal } from "@angular/core";
import type { OnDestroy, OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import { AgentFacade, isApprovalActionDisabled } from "./agent-facade.service.js";
import type { ApprovalRequest } from "@george/protocol";

@Component({
  selector: "george-root",
  standalone: true,
  imports: [DatePipe],
  templateUrl: "./app.component.html"
})
export class AppComponent implements OnInit, OnDestroy {
  readonly facade = inject(AgentFacade);
  readonly input = signal("");
  readonly navigation = ["Inicio", "Chat", "Proyectos", "Memoria", "Actividad", "Ajustes"];

  ngOnInit(): void {
    void this.facade.connect();
  }

  ngOnDestroy(): void {
    this.facade.close();
  }

  async submit(): Promise<void> {
    const value = this.input();
    if (!value.trim()) return;
    this.input.set("");
    await this.facade.send(value);
  }

  onInput(event: Event): void {
    this.input.set((event.target as HTMLInputElement).value);
  }

  resolveApproval(approvalId: string, decision: "approve" | "deny"): void {
    void this.facade.resolveApproval(approvalId, decision);
  }

  approvalActionDisabled(approval: ApprovalRequest): boolean {
    return isApprovalActionDisabled(
      approval.status,
      this.facade.resolvingApprovals().includes(approval.approvalId)
    );
  }
}
