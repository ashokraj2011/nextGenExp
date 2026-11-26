/**
 * Integration resilience primitives (roadmap item 3.3):
 * - Per-integration Token-Bucket Rate Limiter
 * - Per-integration Circuit Breaker (closed -> open -> half_open -> closed)
 * - HMAC-SHA256 signature creation & constant-time verification for async completion callbacks
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Integration, IntegrationResilienceSnapshot } from "../../packages/contracts/integration-task";

type Bucket = {
  tokens: number;
  lastRefillMs: number;
  rejectedCount: number;
};

type Breaker = {
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  openedAtMs?: number;
  rejectedCount: number;
};

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;

export class IntegrationResilience {
  private readonly buckets = new Map<string, Bucket>();
  private readonly breakers = new Map<string, Breaker>();

  constructor(private readonly now: () => number = Date.now) {}

  private breakerConfig(integration: Integration) {
    return {
      failureThreshold: integration.circuitBreaker?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      resetTimeoutMs: integration.circuitBreaker?.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS,
    };
  }

  private getBreaker(id: string): Breaker {
    let b = this.breakers.get(id);
    if (!b) {
      b = { state: "closed", consecutiveFailures: 0, rejectedCount: 0 };
      this.breakers.set(id, b);
    }
    return b;
  }

  /** Checks circuit breaker first, then consumes a rate-limit token if configured. */
  checkBeforeCall(integration: Integration):
    | { ok: true }
    | { ok: false; kind: "circuit_open" | "rate_limited"; retryAfterMs: number; message: string } {
    const t = this.now();
    const cfg = this.breakerConfig(integration);
    const breaker = this.getBreaker(integration.id);

    if (breaker.state === "open") {
      const openedAt = breaker.openedAtMs ?? t;
      const elapsed = t - openedAt;
      if (elapsed >= cfg.resetTimeoutMs) {
        breaker.state = "half_open";
      } else {
        breaker.rejectedCount += 1;
        const retryAfterMs = Math.max(100, cfg.resetTimeoutMs - elapsed);
        return {
          ok: false,
          kind: "circuit_open",
          retryAfterMs,
          message: `Circuit breaker is OPEN for "${integration.name}" after ${breaker.consecutiveFailures} consecutive failure(s). Retry in ${Math.ceil(retryAfterMs / 1000)}s or reset the circuit.`,
        };
      }
    }

    if (integration.rateLimit) {
      const rpm = integration.rateLimit.requestsPerMinute;
      const burst = integration.rateLimit.burst ?? rpm;
      let bucket = this.buckets.get(integration.id);
      if (!bucket) {
        bucket = { tokens: burst, lastRefillMs: t, rejectedCount: 0 };
        this.buckets.set(integration.id, bucket);
      } else {
        const refill = ((t - bucket.lastRefillMs) / 60_000) * rpm;
        bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, refill));
        bucket.lastRefillMs = t;
      }

      if (bucket.tokens < 1) {
        bucket.rejectedCount += 1;
        const retryAfterMs = Math.ceil(((1 - bucket.tokens) / rpm) * 60_000);
        return {
          ok: false,
          kind: "rate_limited",
          retryAfterMs,
          message: `Local rate limit exceeded for "${integration.name}" (${rpm} req/min, burst ${burst}). Retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`,
        };
      }
      bucket.tokens -= 1;
    }

    return { ok: true };
  }

  /** Records a healthy response (closes half-open circuit and clears failure streak). */
  recordSuccess(integration: Integration) {
    const breaker = this.getBreaker(integration.id);
    breaker.state = "closed";
    breaker.consecutiveFailures = 0;
    breaker.openedAtMs = undefined;
  }

  /** Records a transport/timeout/5xx failure and trips the breaker once threshold is reached. */
  recordFailure(integration: Integration) {
    const cfg = this.breakerConfig(integration);
    const breaker = this.getBreaker(integration.id);
    breaker.consecutiveFailures += 1;
    if (breaker.state === "half_open" || breaker.consecutiveFailures >= cfg.failureThreshold) {
      breaker.state = "open";
      breaker.openedAtMs = this.now();
    }
  }

  /** Operator reset: closes circuit and restores full token bucket. */
  reset(integrationId: string) {
    this.breakers.delete(integrationId);
    this.buckets.delete(integrationId);
  }

  snapshot(integration: Integration): IntegrationResilienceSnapshot {
    const t = this.now();
    const cfg = this.breakerConfig(integration);
    const breaker = this.getBreaker(integration.id);
    let effectiveState = breaker.state;
    if (effectiveState === "open" && breaker.openedAtMs !== undefined && t - breaker.openedAtMs >= cfg.resetTimeoutMs) {
      effectiveState = "half_open";
    }
    const bucket = this.buckets.get(integration.id);
    let rateLimitSnap: IntegrationResilienceSnapshot["rateLimit"];
    if (integration.rateLimit) {
      const rpm = integration.rateLimit.requestsPerMinute;
      const burst = integration.rateLimit.burst ?? rpm;
      let tokens = burst;
      if (bucket) {
        const refill = ((t - bucket.lastRefillMs) / 60_000) * rpm;
        tokens = Math.min(burst, bucket.tokens + Math.max(0, refill));
      }
      rateLimitSnap = { requestsPerMinute: rpm, burst, tokensRemaining: Math.floor(tokens * 10) / 10 };
    }
    return {
      integrationId: integration.id,
      circuitState: effectiveState,
      consecutiveFailures: breaker.consecutiveFailures,
      failureThreshold: cfg.failureThreshold,
      resetTimeoutMs: cfg.resetTimeoutMs,
      ...(breaker.openedAtMs !== undefined ? {
        openedAt: new Date(breaker.openedAtMs).toISOString(),
        nextAttemptAt: new Date(breaker.openedAtMs + cfg.resetTimeoutMs).toISOString(),
      } : {}),
      ...(rateLimitSnap ? { rateLimit: rateLimitSnap } : {}),
      rejectedRateLimitCount: bucket?.rejectedCount ?? 0,
      rejectedCircuitCount: breaker.rejectedCount,
    };
  }
}

/** Signs an async completion webhook payload with HMAC-SHA256 (`sha256=<hex>`). */
export function signAsyncCallback(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Constant-time verification of `X-CEP-Signature: sha256=<hex>`. */
export function verifyAsyncCallback(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = signAsyncCallback(rawBody, secret);
  const a = Buffer.from(signatureHeader.trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
