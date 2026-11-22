import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../apps/server/http";
import { startFixtureGateway, type TestInterceptor } from "./gateway-fixture";
import { testProject } from "./client";

export async function startTestPreview(port?: number, intercept?: TestInterceptor) {
  const dir = await mkdtemp(join(tmpdir(), "pzn-test-preview-"));
  const gateway = await startFixtureGateway(intercept);
  const cleanup = async () => {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const app = await startApp({ projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, mode: "test", port });
    return { url: app.url, async close() { await app.close(); await cleanup(); } };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
