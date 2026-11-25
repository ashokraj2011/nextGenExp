import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../apps/server/http";
import { testOperators } from "./operator-fixture";
import { startFixtureGateway, type TestInterceptor } from "./gateway-fixture";
import { testProject } from "./client";

export async function startTestPreview(port?: number, intercept?: TestInterceptor, operators: Record<string, string> | null = testOperators) {
  const dir = await mkdtemp(join(tmpdir(), "pzn-test-preview-"));
  const gateway = await startFixtureGateway(intercept);
  const cleanup = async () => {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, mode: "test", port, operators: operators ?? undefined });
    return { url: app.url, dataDir: dir, async close() { await app.close(); await cleanup(); } };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
