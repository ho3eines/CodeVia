import type { User } from "../domain/entities.js";

/**
 * The pre-login fallback identity used while strict auth is off
 * (`REQUIRE_AUTH=false` / the Admin toggle). Requests without a signed session
 * act as this user; it is never a real login and can never hold a GitHub
 * token, so projects still owned by it are "stranded" (see
 * `adoptStrandedProjects`).
 */
export const DEMO_USER_ID = "user-demo";

export const DEMO_USER: User = {
  id: DEMO_USER_ID,
  externalId: "demo",
  email: "demo@codevia.local",
  name: "Demo Owner",
  role: "owner",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
