/**
 * @sfield/preset-memory: Zero-boilerplate ephemeral development preset for @sfield/core.
 *
 * Enables `SField.create({ config, preset: "memory" })` for tests, notebooks, and local scripts.
 * Refuses to load under `NODE_ENV=production` or `deployment: "service"` (enforced by core).
 */
import {
  EphemeralPersistence,
  InMemoryArtifactStore,
  InMemoryMemoryRepository,
  LOCAL_DEV_PRINCIPAL,
  createDevAuthorizer,
  type PresetComponents,
  type SFieldOptions,
} from "@sfield/core";

export function createPreset(options: SFieldOptions & { configDir: string }): PresetComponents {
  const artifacts = options.artifacts ?? new InMemoryArtifactStore();
  const memory = options.memory ?? new InMemoryMemoryRepository();
  const persistence = options.persistence ?? new EphemeralPersistence({ artifacts, memory });

  return {
    name: "memory",
    deployment: "ephemeral",
    persistence,
    artifacts,
    memory,
    authorizer: options.authorizer ?? createDevAuthorizer(),
    devPrincipal: options.devPrincipal ?? LOCAL_DEV_PRINCIPAL,
    banner: '[sfield] development preset "memory" (ephemeral in-memory store) — not for production',
    components: {
      persistence: "EphemeralPersistence",
      artifacts: "InMemoryArtifactStore",
      memory: "InMemoryMemoryRepository",
      authorizer: "createDevAuthorizer",
    },
  };
}

export default { createPreset };
