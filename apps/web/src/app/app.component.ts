import { Component, ViewChild, effect, inject, signal } from "@angular/core";
import type { ElementRef, OnDestroy, OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import { AgentFacade, isApprovalActionDisabled } from "./agent-facade.service.js";
import { SettingsComponent } from "./settings.component.js";
import type { ApprovalRequest } from "@george/protocol";

export type AppView = "home" | "settings";
const ACTIVATABLE_NAVIGATION_ITEMS: ReadonlySet<string> = new Set(["Inicio", "Chat", "Ajustes"]);

export function isNavigationItemActivatable(item: string): boolean {
  return ACTIVATABLE_NAVIGATION_ITEMS.has(item);
}

/** Pixels of slack from the bottom of the chat history still counted as "at the bottom". */
export const AUTO_SCROLL_NEAR_BOTTOM_PX = 120;

/**
 * Decides whether the chat history should auto-scroll to the newest message.
 * Pure so it stays testable without rendering a real scrollable DOM node.
 */
export function shouldAutoScroll(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number
): boolean {
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  return distanceFromBottom <= AUTO_SCROLL_NEAR_BOTTOM_PX;
}

@Component({
  selector: "george-root",
  standalone: true,
  imports: [DatePipe, SettingsComponent],
  templateUrl: "./app.component.html"
})
export class AppComponent implements OnInit, OnDestroy {
  readonly facade = inject(AgentFacade);
  readonly input = signal("");
  readonly navigation = ["Inicio", "Chat", "Proyectos", "Memoria", "Actividad", "Ajustes"];
  readonly activeView = signal<AppView>("home");
  readonly isNavigationItemActivatable = isNavigationItemActivatable;

  @ViewChild("conversationEl") private conversationRef?: ElementRef<HTMLElement>;
  #lastMessageCount = 0;

  constructor() {
    effect(() => {
      const count = this.facade.messages().length;
      if (count === this.#lastMessageCount) return;
      this.#lastMessageCount = count;
      const el = this.conversationRef?.nativeElement;
      if (el && shouldAutoScroll(el.scrollTop, el.scrollHeight, el.clientHeight)) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  ngOnInit(): void {
    void this.facade.connect();
  }

  selectNavigationItem(item: string): void {
    if (!isNavigationItemActivatable(item)) return;
    this.activeView.set(item === "Ajustes" ? "settings" : "home");
  }

  isNavigationItemActive(item: string): boolean {
    if (item === "Ajustes") return this.activeView() === "settings";
    if (item === "Inicio" || item === "Chat") return this.activeView() === "home";
    return false;
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
