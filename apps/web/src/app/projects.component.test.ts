import "@angular/compiler";
import { describe, expect, it } from "vitest";
import { Injector, runInInjectionContext } from "@angular/core";
import { ProjectsComponent } from "./projects.component.js";
import {
  SettingsApiService,
  type ProjectInfo,
  type ProjectSummary
} from "./settings-api.service.js";

function createComponent(api: Partial<SettingsApiService>): ProjectsComponent {
  const injector = Injector.create({
    providers: [ProjectsComponent, { provide: SettingsApiService, useValue: api }]
  });
  return runInInjectionContext(injector, () => injector.get(ProjectsComponent));
}

const george: ProjectSummary = {
  projectId: "george",
  displayName: "George",
  rootAvailable: true,
  gitRepository: true
};

describe("ProjectsComponent", () => {
  it("loads the project list and auto-selects the first project's detail", async () => {
    const detail: ProjectInfo = { ...george, branch: "main", detached: false };
    const component = createComponent({
      getProjects: async () => ({ projects: [george], truncated: false }),
      getProject: async () => detail
    });
    await component.ngOnInit();
    expect(component.projects()).toEqual([george]);
    expect(component.selectedProjectId()).toBe("george");
    expect(component.selectedProject()).toEqual(detail);
  });

  it("shows a safe message, not a raw error, when the project list fails to load", async () => {
    const component = createComponent({
      getProjects: async () => {
        throw new Error("boom");
      }
    });
    await component.ngOnInit();
    expect(component.projects()).toEqual([]);
    expect(component.statusMessage()).toBe("No se pudo cargar la lista de proyectos.");
  });

  it("shows a safe message, not a raw error, when project detail fails to load", async () => {
    const component = createComponent({
      getProjects: async () => ({ projects: [george], truncated: false }),
      getProject: async () => {
        throw new Error("boom");
      }
    });
    await component.ngOnInit();
    expect(component.selectedProject()).toBeNull();
    expect(component.statusMessage()).toBe("No se pudo cargar la información del proyecto.");
  });

  it("re-selects the currently selected project on refresh", async () => {
    let detailCalls = 0;
    const component = createComponent({
      getProjects: async () => ({ projects: [george], truncated: false }),
      getProject: async () => {
        detailCalls += 1;
        return { ...george, branch: "main" };
      }
    });
    await component.ngOnInit();
    expect(detailCalls).toBe(1);
    await component.refresh();
    expect(detailCalls).toBe(2);
    expect(component.selectedProjectId()).toBe("george");
  });

  it("surfaces an approval_required open result as a request for human approval, not success", async () => {
    const component = createComponent({
      getProjects: async () => ({ projects: [george], truncated: false }),
      getProject: async () => george,
      openProject: async () => ({ status: "approval_required", approvalId: "approval-1" })
    });
    await component.ngOnInit();
    await component.openProject();
    expect(component.statusMessage()).toBe(
      "George necesita tu aprobación para abrir este proyecto. Revisa la solicitud pendiente."
    );
    expect(component.opening()).toBe(false);
  });

  it("surfaces a completed open result distinctly from an approval or a failure", async () => {
    const component = createComponent({
      getProjects: async () => ({ projects: [george], truncated: false }),
      getProject: async () => george,
      openProject: async () => ({ status: "completed" })
    });
    await component.ngOnInit();
    await component.openProject();
    expect(component.statusMessage()).toBe("El proyecto se está abriendo.");
  });

  it("shows a safe message, not a raw error, when opening a project throws", async () => {
    const component = createComponent({
      getProjects: async () => ({ projects: [george], truncated: false }),
      getProject: async () => george,
      openProject: async () => {
        throw new Error("boom");
      }
    });
    await component.ngOnInit();
    await component.openProject();
    expect(component.statusMessage()).toBe("No se pudo abrir el proyecto.");
  });

  it("does nothing when opening with no project selected", async () => {
    const component = createComponent({
      getProjects: async () => ({ projects: [], truncated: false })
    });
    await component.ngOnInit();
    await component.openProject();
    expect(component.statusMessage()).toBeNull();
  });
});

describe("ProjectsComponent.toGitStatusView", () => {
  it("extracts only known-safe numeric/branch fields from an arbitrary Git status payload", () => {
    const component = createComponent({});
    expect(
      component.toGitStatusView({
        branch: "main",
        modifiedCount: 2,
        untrackedCount: 1,
        stagedCount: 0,
        extraneous: "ignored"
      })
    ).toEqual({ branch: "main", modifiedCount: 2, untrackedCount: 1, stagedCount: 0 });
  });

  it("returns null for a non-object payload instead of throwing", () => {
    const component = createComponent({});
    expect(component.toGitStatusView(undefined)).toBeNull();
    expect(component.toGitStatusView("not an object")).toBeNull();
  });
});
