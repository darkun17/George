import { describe, expect, it } from "vitest";
import { isSensitivePath } from "./sensitive-files.js";

describe("isSensitivePath", () => {
  it("denies common secret file names", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.production")).toBe(true);
    expect(isSensitivePath("private.pem")).toBe(true);
    expect(isSensitivePath("server.key")).toBe(true);
    expect(isSensitivePath("id_rsa")).toBe(true);
    expect(isSensitivePath("id_ed25519")).toBe(true);
    expect(isSensitivePath("credentials.json")).toBe(true);
    expect(isSensitivePath("secrets.yaml")).toBe(true);
    expect(isSensitivePath("cert.pfx")).toBe(true);
    expect(isSensitivePath("cert.p12")).toBe(true);
  });

  it("is case-insensitive on Windows-style names", () => {
    expect(isSensitivePath(".ENV")).toBe(true);
    expect(isSensitivePath("ID_RSA")).toBe(true);
    expect(isSensitivePath("Server.KEY")).toBe(true);
  });

  it("denies a sensitive file nested in a subdirectory", () => {
    expect(isSensitivePath("config/.env")).toBe(true);
    expect(isSensitivePath("config\\secrets.json")).toBe(true);
    expect(isSensitivePath("deploy/keys/id_rsa")).toBe(true);
  });

  it("does not deny a harmless file with a similar but distinct name", () => {
    expect(isSensitivePath("environment.ts")).toBe(false);
    expect(isSensitivePath("keyboard.ts")).toBe(false);
    expect(isSensitivePath("README.md")).toBe(false);
    expect(isSensitivePath("src/index.ts")).toBe(false);
    expect(isSensitivePath("package.json")).toBe(false);
  });
});
