import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../apps/server/http";
import { isolatedServices, testOperators } from "./operator-fixture";
import { startFixtureGateway, type TestInterceptor } from "./gateway-fixture";
import { testProject } from "./client";

type PreviewOptions = Pick<Parameters<typeof startApp>[0], "operators" | "operatorAuth"> & { dataDir?: string };

export async function startTestPreview(port?: number, intercept?: TestInterceptor, options: PreviewOptions = { operators: testOperators }) {
  const dir = options.dataDir ? resolve(options.dataDir) : await mkdtemp(join(tmpdir(), "pzn-test-preview-"));
  const gateway = await startFixtureGateway(intercept);
  const cleanup = async () => {
    await gateway.close();
    if (!options.dataDir) await rm(dir, { recursive: true, force: true });
  };
  try {
    const app = await startApp({
      projectRoot: fileURLToPath(testProject), dataDir: dir, gateway: gateway.settings, ...isolatedServices, port,
      operatorAuth: options.operatorAuth, operators: options.operators ?? (options.operatorAuth === "off" ? {} : undefined),
    });
    return { url: app.url, dataDir: dir, async close() { await app.close(); await cleanup(); } };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
