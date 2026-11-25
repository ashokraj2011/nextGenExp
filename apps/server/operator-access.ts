import { tenantCookie } from "./tenant";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

function equal(a: string, b: string) {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

export function operatorAccess(dataDir: string, configured?: Record<string, string>) {
  let entries: unknown = configured;
  if (entries === undefined) {
    const path = join(dataDir, "operator-credentials.json");
    mkdirSync(dataDir, { recursive: true });
    try { writeFileSync(path, JSON.stringify({ operator: randomBytes(24).toString("base64url") }), { flag: "wx", mode: 0o600 }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    entries = JSON.parse(readFileSync(path, "utf8"));
  }
  if (!entries || Array.isArray(entries) || typeof entries !== "object") throw new Error("Invalid operator credentials");
  const users = new Map(Object.entries(entries));
  for (const [name, pass] of users) {
    if (!name.trim() || name.includes(":") || name.length > 80 || typeof pass !== "string" || pass.length < 12) throw new Error("Use named operator accounts and passwords of at least 12 characters");
  }
  const cookieName = tenantCookie("pzn_operator");
  const cookiePattern = new RegExp("(?:^|;\\s*)" + cookieName + "=([\\w-]+)\\.([\\w-]+)(?:;|$)");
  const key = randomBytes(32);
  const sign = (s: string) => createHmac("sha256", key).update(s).digest("base64url");
  return (req: IncomingMessage, res: ServerResponse): string | undefined => {
    const basic = req.headers.authorization;
    if (basic) {
      if (!basic.startsWith("Basic ")) return;
      const decoded = Buffer.from(basic.slice(6), "base64").toString();
      const split = decoded.indexOf(":");
      const name = decoded.slice(0, split);
      const pass = users.get(name);
      if (split < 1 || !pass || !equal(pass, decoded.slice(split + 1))) return;
      if (!req.url?.startsWith("/api/")) {
        const token = Buffer.from(JSON.stringify([name, Date.now() + 8 * 3600_000])).toString("base64url");
        res.appendHeader("Set-Cookie", cookieName + "=" + token + "." + sign(token) + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800");
      }
      return name;
    }
    const match = req.headers.cookie?.match(cookiePattern);
    if (!match || !equal(sign(match[1]), match[2])) return;
    const [name, expires] = JSON.parse(Buffer.from(match[1], "base64url").toString());
    if (users.has(name) && expires > Date.now()) return name;
  };
}
