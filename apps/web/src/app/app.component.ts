import { Component, inject, signal } from "@angular/core";
import type { OnDestroy, OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import { AgentFacade } from "./agent-facade.service.js";

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
}
