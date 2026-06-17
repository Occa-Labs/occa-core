// Signs and POSTs a single webhook payload, then records the outcome.
// Signature is HMAC-SHA256 over the exact JSON body, keyed by the
// webhook's secret — the receiver recomputes it to authenticate the
// request. Never throws: delivery is best-effort, a failure is recorded
// and surfaced as `ok: false`.

import crypto from "node:crypto";
import { childLogger } from "../../../lib/logger";
import {
  recordWebhookDelivery,
  type CompanyWebhookRow,
} from "../repositories/webhooks";
import type { TaskCompletedPayload } from "../domain/types";

const log = childLogger("services:webhooks:deliver");

const SIGNATURE_HEADER = "X-OCCA-Signature";
const EVENT_HEADER = "X-OCCA-Event";
const DELIVERY_HEADER = "X-OCCA-Delivery";
const DELIVERY_TIMEOUT_MS = 10_000;
const ERROR_DETAIL_MAX = 500;
// Cap on the receiver's raw response body we persist for the operator to
// inspect. Opaque to OCCA — stored and rendered as-is.
const RESPONSE_BODY_MAX = 2_000;

export interface DeliveryResult {
  ok: boolean;
  /** HTTP status string, or "error" when the request itself failed. */
  status: string;
  /**
   * Canonical URL of the published resource, when the receiver returns one
   * in its 2xx JSON body as `{ "url": "..." }` (e.g. a publish target returns the
   * live article URL). Null otherwise. Used to populate the on-chain
   * `result_uri` so provenance links back to the published artifact.
   */
  resultUri: string | null;
  /**
   * The receiver's raw response body, capped. Opaque to OCCA — surfaced
   * to the operator as-is, no per-destination parsing. Null when empty or
   * when the request itself failed before a response.
   */
  response: string | null;
}

export async function deliverWebhook(
  webhook: CompanyWebhookRow,
  payload: TaskCompletedPayload,
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", webhook.secret)
    .update(body)
    .digest("hex");
  const deliveryId = crypto.randomUUID();

  try {
    const response = await fetch(webhook.targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: `sha256=${signature}`,
        [EVENT_HEADER]: payload.event,
        [DELIVERY_HEADER]: deliveryId,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    const status = String(response.status);
    const rawBody = await response.text().catch(() => "");
    const responseBody = rawBody ? rawBody.slice(0, RESPONSE_BODY_MAX) : null;

    if (!response.ok) {
      log.warn(
        { webhookId: webhook.id, status, deliveryId },
        "webhook delivery returned non-2xx",
      );
      await recordWebhookDelivery({
        webhookId: webhook.id,
        status,
        error: rawBody.slice(0, ERROR_DETAIL_MAX) || `HTTP ${status}`,
        response: responseBody,
      });
      return { ok: false, status, resultUri: null, response: responseBody };
    }

    // Capture the receiver's canonical URL when it returns one in the 2xx
    // JSON body (e.g. a publish target returns `{ url, slug }`). Best-effort: a
    // non-JSON or url-less body just yields null.
    let resultUri: string | null = null;
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as { url?: unknown };
        if (typeof parsed.url === "string" && parsed.url.length > 0) {
          resultUri = parsed.url;
        }
      } catch {
        /* receiver didn't return JSON — fine, no URL to capture */
      }
    }

    log.info(
      { webhookId: webhook.id, status, deliveryId },
      "webhook delivered",
    );
    await recordWebhookDelivery({
      webhookId: webhook.id,
      status,
      error: null,
      response: responseBody,
    });
    return { ok: true, status, resultUri, response: responseBody };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, webhookId: webhook.id, deliveryId },
      "webhook delivery failed",
    );
    await recordWebhookDelivery({
      webhookId: webhook.id,
      status: "error",
      error: message,
      response: null,
    });
    return { ok: false, status: "error", resultUri: null, response: null };
  }
}
