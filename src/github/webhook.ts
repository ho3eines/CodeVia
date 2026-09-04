import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "../config/env.js";

/**
 * Validates a GitHub webhook payload using the X-Hub-Signature-256 HMAC.
 * The signing secret comes from the environment (GITHUB_WEBHOOK_SECRET) and is
 * never stored in the repository.
 */
export function verifyGithubSignature(
  secret: string,
  signatureHeader: string | undefined,
  rawBody: string,
): boolean {
  if (!secret) return false;
  if (!signatureHeader) return false;
  const match = /^sha256=(.+)$/.exec(signatureHeader);
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = match[1];
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function getWebhookSecret(): string | undefined {
  return getEnv().GITHUB_WEBHOOK_SECRET;
}
