// Standalone deployment:'service' example using Postgres with automatic durable JSON-file fallback
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SField, approveLock, createDevAuthorizer, LOCAL_DEV_PRINCIPAL } from "@sfield/core";
import { createPostgresOrJsonPersistence } from "@sfield/store-postgres";

const dir = mkdtempSync(join(tmpdir(), "sfield-service-demo-"));
const jsonPath = join(dir, "service-state.json");

try {
  const config = { version: 1, models: {}, agents: {} };
  const val = await SField.validate({ config });

  // No Postgres client passed -> automatically falls back to durable atomic JSON file at jsonPath
  const persistence = createPostgresOrJsonPersistence({
    jsonPath,
    onFallback: (reason) => console.log("Fallback activated:", reason),
  });
  await persistence.init({ namespace: "demo", ownerId: "node-1" });
  console.log("Active backend:", persistence.activeBackend(), "Health:", await persistence.health());

  // Approve config lock digest (required in deployment: "service")
  await approveLock(
    { digest: val.digest, approver: "release-engineer", comment: "Example approval" },
    undefined,
    { lockApprovals: persistence.lockApprovals, evalReports: persistence.evalReports },
  );

  const sf = await SField.create({
    config,
    deployment: "service",
    persistence,
    authorizer: createDevAuthorizer(),
    devPrincipal: LOCAL_DEV_PRINCIPAL,
    quiet: true,
  });

  console.log("Service lock status:", await sf.lock.status());
  await sf.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
