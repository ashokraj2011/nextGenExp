import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startApp } from "../apps/server/http";
import { sfieldTools } from "../packages/contracts/tool-setup";
import { createTreatmentSelectorProvider, RecommendationArbitrator } from "../packages/recommendations";
import { createDefaultTsAdapterFactory, createRemoteTsAdapterFactory, RemoteTsAdapter } from "../packages/ts-adapter";

test("TS is categorized as a recommendation_provider tool and apps/server has zero direct FixtureTsAdapter instantiations", async () => {
  assert.equal(sfieldTools.selection.category, "recommendation_provider");
  assert.equal(sfieldTools.catalog.category, "recommendation_provider");
  assert.equal(sfieldTools.propensity.category, "recommendation_provider");
  assert.equal(sfieldTools.portfolio.category, "data_read");

  const arbitrator = new RecommendationArbitrator([
    createTreatmentSelectorProvider(async () => ({
      recommendations: { schemaVersion: "2.0", recommendations: [{ kind: "content", id: "fund_account" }] },
    })),
  ]);
  const [desc] = arbitrator.descriptors();
  assert.equal(desc.id, "treatment_selector");
  assert.equal(desc.category, "recommendation_provider");
  assert.equal(desc.toolRef, "treatments.eligible@1.0.0");

  // Verify no file under apps/server/ constructs new FixtureTsAdapter directly
  const serverDir = join(process.cwd(), "apps/server");
  const files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  }
  await walk(serverDir);
  for (const file of files) {
    const src = await readFile(file, "utf8");
    assert.equal(src.includes("new FixtureTsAdapter"), false, `Direct new FixtureTsAdapter found in ${file}`);
  }
});

test("Shared RemoteTsAdapterFactory delivers identical decisions for Marcus across Pending Actions and Admin Tool Setup preview", async () => {
  const seenRequests: Array<{ path: string; mid?: string; context?: string }> = [];
  const mockRemoteTs = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    seenRequests.push({ path: req.url ?? "", mid: body.mid, context: body.context });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/select") {
      res.end(JSON.stringify({
        contentIds: ["fund_account"],
        recommendations: {
          schemaVersion: "2.0",
          recommendations: [
            { kind: "content", id: "fund_account" },
            { kind: "workflow", id: "account.funding.preview", version: "1.0.0", forContentIds: ["fund_account"] },
          ],
        },
      }));
      return;
    }
    res.end(JSON.stringify({}));
  });
  await new Promise<void>((resolve) => mockRemoteTs.listen(0, "127.0.0.1", resolve));
  const tsAddr = mockRemoteTs.address();
  assert.ok(tsAddr && typeof tsAddr === "object");
  const endpoint = `http://127.0.0.1:${tsAddr.port}`;

  // Verify createDefaultTsAdapterFactory auto-selects RemoteTsAdapter when PZN_TS_ENDPOINT is set
  const envFactory = createDefaultTsAdapterFactory({ PZN_TS_ENDPOINT: endpoint, PZN_TS_API_KEY: "test-key" });
  const envAdapter = envFactory({ state: { scenarioId: "normal", ordinal: 1 } });
  assert.ok(envAdapter instanceof RemoteTsAdapter);

  const dataDir = await mkdtemp(join(tmpdir(), "cep-ts-shared-"));
  const app = await startApp({
    dataDir,
    projectRoot: process.cwd(),
    gateway: null,
    port: 0,
    operatorAuth: "off",
    startScheduledJobs: false,
    tsAdapterFactory: createRemoteTsAdapterFactory({ endpoint }),
  });

  try {
    // 1. Pending Actions for Marcus (demo-new-account)
    const pendingRes = await fetch(`${app.url}/api/workspace/demo-new-account/pending-actions`);
    assert.equal(pendingRes.status, 200);
    const pending = await pendingRes.json() as Array<{ contentId: string; action: { kind: string } }>;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].contentId, "fund_account");
    assert.equal(pending[0].action.kind, "funding");

    // 2. Admin Tool Setup preview for Marcus (demo-new-account)
    const previewRes = await fetch(`${app.url}/api/admin/treatment-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId: "normal",
        contextId: "pending-actions",
        personaId: "demo-new-account",
        ordinal: 1,
        enabled: true,
        output: null,
        ccreRules: [],
      }),
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json() as { status: string; contentIds: string[]; workflows?: Array<{ id: string }> };
    assert.equal(preview.status, "ranked");
    assert.deepEqual(preview.contentIds, ["fund_account"]);
    assert.equal(preview.workflows?.[0]?.id, "account.funding.preview");

    // Both Pending Actions and Admin Preview hit the exact same shared RemoteTsAdapter endpoint with Marcus's MID
    assert.equal(seenRequests.length, 2);
    assert.equal(seenRequests[0].path, "/select");
    assert.equal(seenRequests[1].path, "/select");
    assert.equal(seenRequests[0].mid, seenRequests[1].mid);
    assert.equal(seenRequests[0].context, "pending-actions");
    assert.equal(seenRequests[1].context, "pending-actions");
  } finally {
    await app.close();
    await new Promise<void>((resolve) => mockRemoteTs.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
