/**
 * Persists tenant-specific `/` slash commands for CEP on top of `@sfield/core`'s
 * `SlashCommandService` (`sf.commands`), storing overrides in `${dataDir}/slash-commands.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SlashCommandService, type SlashCommandDefinition } from "@sfield/core";

export const DEFAULT_CEP_SLASH_COMMANDS: SlashCommandDefinition[] = [
  { command: "/portfolio", label: "Portfolio summary", hint: "Show balances & allocation mix", action: "prompt", prompt: "Let me know my portfolio summary.", domain: "wealth" },
  { command: "/goal", label: "Home-buying goal", hint: "Track savings progress & target", action: "prompt", prompt: "Show my home-buying goal and savings progress.", domain: "wealth" },
  { command: "/plan", label: "2-year savings plan", hint: "Interactive contribution simulator", action: "prompt", prompt: "I want to buy a house in two years. Show me how close I am and help me explore a savings plan.", domain: "wealth" },
  { command: "/retirement", label: "Retirement accounts", hint: "Review accounts & beneficiary status", action: "prompt", prompt: "Show my retirement accounts.", domain: "wealth" },
  { command: "/compare", label: "Compare balances", hint: "Available vs. current balance side by side", action: "prompt", prompt: "Compare available and current balance.", domain: "wealth" },
  { command: "/futures", label: "Parallel Futures simulator", hint: "Compare Scenario A vs B side-by-side & commit", action: "futures" },
  { command: "/watch", label: "Create Living Watchcard", hint: "Autonomous sentinel that wakes up when reality changes", action: "watch" },
  { command: "/delegate", label: "Personal AI (A2A) Delegation", hint: "Mint a scoped pass for your personal AI to negotiate", action: "delegate" },
  { command: "/advisor", label: "Talk to a live advisor", hint: "Multiplayer Live Glass handoff with AI brief", action: "advisor" },
  { command: "/memory", label: "Manage personal memory", hint: "View, save, or forget your preferences", action: "memory" },
  { command: "/upload", label: "Attach document", hint: "Upload invoice, CSV, log, or image", action: "upload" },
];

export function hydrateTenantSlashCommands(service: SlashCommandService, dataDir: string, tenantId: string): void {
  service.registerDefaults(DEFAULT_CEP_SLASH_COMMANDS);
  const filePath = join(dataDir, "slash-commands.json");
  if (!existsSync(filePath)) return;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      service.setTenantCommands(tenantId, raw as SlashCommandDefinition[]);
    }
  } catch {
    // ignore malformed override file
  }
}

export function persistTenantSlashCommands(service: SlashCommandService, dataDir: string, tenantId: string): void {
  const filePath = join(dataDir, "slash-commands.json");
  mkdirSync(dirname(filePath), { recursive: true });
  const list = service.list({ tenantId, includeDisabled: true });
  writeFileSync(filePath, JSON.stringify(list, null, 2), "utf8");
}
