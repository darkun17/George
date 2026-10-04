import "@angular/compiler";
import { describe, expect, it } from "vitest";
import { doctorCheckLabel, doctorStateLabel } from "./settings.component.js";

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
