import { createHash } from "node:crypto";
import { canonicalStableJson } from "./contracts";

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalStableJson(value)).digest("hex");
}

export function fingerprintToolContract(toolRef: string, inputSchema: unknown, outputSchema: unknown): string {
  return sha256Hex({ toolRef, inputSchema, outputSchema });
}
