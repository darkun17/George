import "@angular/compiler";
import { describe, expect, it } from "vitest";
import { Injector, runInInjectionContext } from "@angular/core";
import { SettingsComponent, doctorCheckLabel, doctorStateLabel } from "./settings.component.js";
import { SettingsApiService, type ProjectSummary } from "./settings-api.service.js";

describe("doctorStateLabel", () => {
  it("maps every Doctor state to a distinct safe Spanish label", () => {
    expect(doctorStateLabel("AVAILABLE")).toBe("Disponible");
    expect(doctorStateLabel("UNAVAILABLE")).toBe("No disponible");
    expect(doctorStateLabel("MISCONFIGURED")).toBe("Mal configurado");
    expect(doctorStateLabel("DISABLED")).toBe("Deshabilitado");
    expect(doctorStateLabel("NOT_INSTALLED")).toBe("No instalado");
  });
});

describe("doctorCheckLabel", () => {
  it("maps known check ids to a human label", () => {
    expect(doctorCheckLabel("provider")).toBe("Proveedor de IA");
    expect(doctorCheckLabel("auditDatabase")).toBe("Base de auditoría");
  });

  it("falls back to the raw id for an unknown check without throwing", () => {
    expect(doctorCheckLabel("some.future.check")).toBe("some.future.check");
  });
});

function createSettings(api: Partial<SettingsApiService>): SettingsComponent {
  const injector = Injector.create({
    providers: [SettingsComponent, { provide: SettingsApiService, useValue: api }]
  });
  return runInInjectionContext(injector, () => injector.get(SettingsComponent));
}

const noopApi: Partial<SettingsApiService> = {
  getSettings: async () => ({
    assistant: { name: "George", language: "es" },
    user: {},
    ai: { provider: "mock" }
  }),
  getDoctorReport: async () => ({
    generatedAt: "2026-10-04T00:00:00.000Z",
    core: [],
    ai: [],
    security: [],
    system: [],
    voice: [],
    git: [],
    projects: []
  }),
  getApplications: async () => ({ applications: [] })
};

const george: ProjectSummary = {
  projectId: "george",
  displayName: "George",
  rootAvailable: true,
  gitRepository: true
};

describe("SettingsComponent project management", () => {
  it("loads configured projects and available applications on init", async () => {
    const component = createSettings({
      ...noopApi,
      getProjects: async () => ({ projects: [george], truncated: false }),
      getApplications: async () => ({
        applications: [{ id: "vscode", displayName: "Visual Studio Code", available: true }]
      })
    });
    await component.ngOnInit();
    expect(component.projects()).toEqual([george]);
    expect(component.applications()).toEqual([
      { id: "vscode", displayName: "Visual Studio Code", available: true }
    ]);
  });

  it("opens a blank add form, distinct from editing an existing project", () => {
    const component = createSettings(noopApi);
    component.startAddProject();
    expect(component.editingProjectId()).toBeNull();
    expect(component.projectFormId()).toBe("");
    expect(component.projectFormOpen()).toBe(true);

    component.startEditProject(george);
    expect(component.editingProjectId()).toBe("george");
    expect(component.projectFormDisplayName()).toBe("George");
  });

  it("adds a new project and refreshes the list on success", async () => {
    let addedWith: unknown;
    const component = createSettings({
      ...noopApi,
      getProjects: async () => ({ projects: [george], truncated: false }),
      addProject: async (input) => {
        addedWith = input;
        return george;
      }
    });
    component.startAddProject();
    component.projectFormId.set("george");
    component.projectFormDisplayName.set("George");
    component.projectFormRootPath.set("C:\\Proyectos\\George");
    await component.saveProject();
    expect(addedWith).toMatchObject({
      id: "george",
      displayName: "George",
      rootPath: "C:\\Proyectos\\George"
    });
    expect(component.projectFormOpen()).toBe(false);
    expect(component.projects()).toEqual([george]);
  });

  it("shows a safe error and keeps the form open when adding a project fails", async () => {
    const component = createSettings({
      ...noopApi,
      addProject: async () => {
        throw new Error("boom");
      }
    });
    component.startAddProject();
    component.projectFormDisplayName.set("George");
    component.projectFormRootPath.set("C:\\Proyectos\\George");
    await component.saveProject();
    expect(component.projectFormOpen()).toBe(true);
    expect(component.projectFormError()).toBe(
      "No se pudo guardar el proyecto. Verifica la ruta y que el identificador no esté en uso."
    );
  });

  it("requires an explicit confirmation step before removing a project, worded so it never implies deleting the folder", async () => {
    let removedId: string | undefined;
    const component = createSettings({
      ...noopApi,
      getProjects: async () => ({ projects: [], truncated: false }),
      removeProject: async (id) => {
        removedId = id;
      }
    });
    component.askRemoveProject("george");
    expect(component.confirmingRemoveProjectId()).toBe("george");
    component.cancelRemoveProject();
    expect(component.confirmingRemoveProjectId()).toBeNull();
    expect(removedId).toBeUndefined();

    component.askRemoveProject("george");
    await component.confirmRemoveProject("george");
    expect(removedId).toBe("george");
    expect(component.confirmingRemoveProjectId()).toBeNull();
  });

  it("shows a safe message, not a raw error, when removing a project fails", async () => {
    const component = createSettings({
      ...noopApi,
      removeProject: async () => {
        throw new Error("boom");
      }
    });
    await component.confirmRemoveProject("george");
    expect(component.projectStatusMessage()).toBe("No se pudo quitar el proyecto.");
  });
});
