/**
 * @sfield/preset-local: Zero-boilerplate durable local development preset for @sfield/core.
 *
 * Enables `SField.create({ config, preset: "local" })` backed by SQLite + FilesystemArtifactStore
 * under `<configDir>/.sfield/` (or `SFIELD_LOCAL_DIR`).
 */
import { join, resolve } from "node:path";
import {
  FilesystemArtifactStore,
  LOCAL_DEV_PRINCIPAL,
  createDevAuthorizer,
  type PresetComponents,
  type SFieldOptions,
} from "@sfield/core";
import { sqlitePersistence } from "@sfield/store-sqlite";

export function createPreset(options: SFieldOptions & { configDir: string }): PresetComponents {
  const envDir = options.env?.["SFIELD_LOCAL_DIR"] ?? process.env["SFIELD_LOCAL_DIR"];
  const baseDir = resolve(envDir || join(options.configDir, ".sfield"));
  const dbPath = join(baseDir, "state.sqlite");
  const artifactsDir = join(baseDir, "artifacts");

  const persistence = options.persistence ?? sqlitePersistence({ path: dbPath });
  const artifacts = options.artifacts ?? new FilesystemArtifactStore({ rootDir: artifactsDir });

  return {
    name: "local",
    deployment: "durable_single",
    persistence,
    artifacts,
    ...(persistence.memory ? { memory: persistence.memory } : {}),
    authorizer: options.authorizer ?? createDevAuthorizer(),
    devPrincipal: options.devPrincipal ?? LOCAL_DEV_PRINCIPAL,
    banner: `[sfield] development preset "local" (${dbPath}) — not for production`,
    components: {
      persistence: `SqlitePersistence(${dbPath})`,
      artifacts: `FilesystemArtifactStore(${artifactsDir})`,
      memory: "SqliteMemoryRepository",
      authorizer: "createDevAuthorizer",
    },
  };
}

export default { createPreset };
