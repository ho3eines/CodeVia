import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getAuthSecret } from "./github-oauth.js";

/*
 * Small reusable encrypted-at-rest secret store for configuration secrets that
 * must be typed into the UI (e.g. an LLM API key or a per-user Telegram bot
 * token). Encryption is AES-256-GCM in the same style as per-user GitHub
 * tokens: the key is derived from AUTH_SECRET, the record never leaves the
 * runtime store in clear text, and responses never include the plaintext.
 *
 * Rotating AUTH_SECRET makes previously stored values undecryptable; they are
 * treated as absent and must be re-entered.
 */

export interface EncryptedValue {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

function keyFor(context: string, secret?: string): Buffer {
  return createHash("sha256").update(`${secret ?? getAuthSecret()}:${context}`).digest();
}

export function encryptSecret(value: string, context: "provider-secret" | "telegram-token" = "provider-secret"): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(context), iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function decryptSecret(rec: EncryptedValue | string | undefined, context: "provider-secret" | "telegram-token" = "provider-secret"): string | undefined {
  let parsed: EncryptedValue | undefined;
  if (typeof rec === "string") {
    try {
      parsed = JSON.parse(rec) as EncryptedValue;
    } catch {
      return undefined;
    }
  } else {
    parsed = rec;
  }
  if (!parsed || parsed.v !== 1) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(context), Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parsed.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

export function maskSecret(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}
