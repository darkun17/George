import { Component, inject, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import {
  SettingsApiService,
  type ProjectInfo,
  type ProjectSummary
} from "./settings-api.service.js";

interface GitStatusView {
  readonly branch?: string | null;
  readonly modifiedCount?: number;
  readonly untrackedCount?: number;
  readonly stagedCount?: number;
}

function toGitStatusView(value: unknown): GitStatusView | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record["branch"] === "string" || record["branch"] === null
      ? { branch: record["branch"] as string | null }
      : {}),
    ...(typeof record["modifiedCount"] === "number"
      ? { modifiedCount: record["modifiedCount"] }
      : {}),
    ...(typeof record["untrackedCount"] === "number"
      ? { untrackedCount: record["untrackedCount"] }
      : {}),
    ...(typeof record["stagedCount"] === "number" ? { stagedCount: record["stagedCount"] } : {})
  };
}

@Component({
  selector: "george-projects",
  standalone: true,
  templateUrl: "./projects.component.html"
})
export class ProjectsComponent implements OnInit {
  readonly #api = inject(SettingsApiService);

  readonly projects = signal<readonly ProjectSummary[]>([]);
  readonly selectedProjectId = signal<string | null>(null);
  readonly selectedProject = signal<(ProjectInfo & { readonly gitStatus?: unknown }) | null>(null);
  readonly loadingDetail = signal(false);
  readonly statusMessage = signal<string | null>(null);
  readonly opening = signal(false);
  readonly toGitStatusView = toGitStatusView;

  async ngOnInit(): Promise<void> {
    await this.#loadProjects();
  }

  async #loadProjects(): Promise<void> {
    try {
      const result = await this.#api.getProjects();
      this.projects.set(result.projects);
      const current = this.selectedProjectId();
      if (!current && result.projects.length > 0) {
        await this.selectProject(result.projects[0]!.projectId);
      }
    } catch {
      this.statusMessage.set("No se pudo cargar la lista de proyectos.");
    }
  }

  async selectProject(projectId: string): Promise<void> {
    this.selectedProjectId.set(projectId);
    this.loadingDetail.set(true);
    this.statusMessage.set(null);
    try {
      this.selectedProject.set(await this.#api.getProject(projectId));
    } catch {
      this.selectedProject.set(null);
      this.statusMessage.set("No se pudo cargar la información del proyecto.");
    } finally {
      this.loadingDetail.set(false);
    }
  }

  async refresh(): Promise<void> {
    const projectId = this.selectedProjectId();
    await this.#loadProjects();
    if (projectId) await this.selectProject(projectId);
  }

  async openProject(): Promise<void> {
    const projectId = this.selectedProjectId();
    if (!projectId) return;
    this.opening.set(true);
    this.statusMessage.set(null);
    try {
      const result = await this.#api.openProject(projectId);
      this.statusMessage.set(
        result.status === "approval_required"
          ? "George necesita tu aprobación para abrir este proyecto. Revisa la solicitud pendiente."
          : result.status === "completed"
            ? "El proyecto se está abriendo."
            : "No se pudo abrir el proyecto."
      );
    } catch {
      this.statusMessage.set("No se pudo abrir el proyecto.");
    } finally {
      this.opening.set(false);
    }
  }
}
