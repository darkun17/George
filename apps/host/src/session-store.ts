import { randomBytes, timingSafeEqual } from "node:crypto";

export interface LocalSession {
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export class SessionStore {
  readonly #sessions = new Map<string, LocalSession>();
  readonly #bootstrapCounts = new Map<string, { count: number; resetsAt: number }>();

  constructor(
    private readonly ttlMs = 8 * 60 * 60 * 1000,
    private readonly maxSessions = 128,
    private readonly maxBootstrapsPerMinute = 20
  ) {}

  create(
    remoteAddress: string,
    now = Date.now()
  ): { token: string; csrfToken: string; expiresAt: number } | undefined {
    this.#prune(now);
    const rate = this.#bootstrapCounts.get(remoteAddress);
    if (rate && rate.resetsAt > now && rate.count >= this.maxBootstrapsPerMinute) return undefined;
    if (this.#sessions.size >= this.maxSessions) return undefined;

    if (rate && rate.resetsAt > now) rate.count++;
    else this.#bootstrapCounts.set(remoteAddress, { count: 1, resetsAt: now + 60_000 });

    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = now + this.ttlMs;
    this.#sessions.set(token, { csrfToken, expiresAt });
    return { token, csrfToken, expiresAt };
  }

  validate(token: string | undefined, now = Date.now()): LocalSession | undefined {
    if (!token) return undefined;
    const session = this.#sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= now) {
      this.#sessions.delete(token);
      return undefined;
    }
    return session;
  }

  validateCsrf(session: LocalSession, candidate: string | undefined): boolean {
    if (!candidate) return false;
    const expected = Buffer.from(session.csrfToken, "utf8");
    const actual = Buffer.from(candidate, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  #prune(now: number): void {
    for (const [token, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(token);
    }
    for (const [address, rate] of this.#bootstrapCounts) {
      if (rate.resetsAt <= now) this.#bootstrapCounts.delete(address);
    }
  }
}

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const segment of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = segment.trim().split("=");
    if (rawName === "george_session") return rawValue.join("=") || undefined;
  }
  return undefined;
}
