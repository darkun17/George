import "@angular/compiler";
import { describe, expect, it } from "vitest";
import {
  AUTO_SCROLL_NEAR_BOTTOM_PX,
  isNavigationItemActivatable,
  shouldAutoScroll
} from "./app.component.js";

describe("shouldAutoScroll", () => {
  it("auto-scrolls when the viewer is already at or near the bottom", () => {
    expect(shouldAutoScroll(1000, 1000, 400)).toBe(true); // exactly at the bottom
    expect(shouldAutoScroll(1000 - AUTO_SCROLL_NEAR_BOTTOM_PX, 1000, 400)).toBe(true); // at the slack boundary
  });

  it("does not auto-scroll when the viewer has scrolled far up intentionally", () => {
    expect(shouldAutoScroll(0, 3000, 400)).toBe(false);
    expect(shouldAutoScroll(1000, 3000, 400)).toBe(false);
  });

  it("auto-scrolls when content does not overflow the viewport at all", () => {
    expect(shouldAutoScroll(0, 200, 400)).toBe(true);
  });
});

describe("isNavigationItemActivatable", () => {
  it("only activates navigation items that have real functionality", () => {
    expect(isNavigationItemActivatable("Inicio")).toBe(true);
    expect(isNavigationItemActivatable("Chat")).toBe(true);
    expect(isNavigationItemActivatable("Ajustes")).toBe(true);
  });

  it("keeps not-yet-built sections disabled", () => {
    expect(isNavigationItemActivatable("Proyectos")).toBe(false);
    expect(isNavigationItemActivatable("Memoria")).toBe(false);
    expect(isNavigationItemActivatable("Actividad")).toBe(false);
  });
});
