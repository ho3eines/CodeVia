import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyGithubSignature } from "../github/webhook.js";

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("GitHub webhook signature validation", () => {
  const secret = "super-secret-signing-key";
  const body = JSON.stringify({ repository: { full_name: "acme/accounting" }, push: {} });

  it("accepts a valid signature", () => {
    expect(verifyGithubSignature(secret, sign(secret, body), body)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = sign(secret, body);
    expect(verifyGithubSignature(secret, sig, body + " ")).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = sign("other-secret", body);
    expect(verifyGithubSignature(secret, sig, body)).toBe(false);
  });

  it("rejects missing signature header", () => {
    expect(verifyGithubSignature(secret, undefined, body)).toBe(false);
  });

  it("rejects a missing secret", () => {
    expect(verifyGithubSignature("", sign(secret, body), body)).toBe(false);
  });
});
