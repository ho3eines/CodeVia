import { describe, it, expect } from "vitest";
import { PLATFORM_CAPABILITIES_PROMPT } from "../http/routes/conversations.js";

describe("project chat knows it can apply changes", () => {
  it("tells the model about Autonomous/Agent modes and forbids 'I cannot push'", () => {
    expect(PLATFORM_CAPABILITIES_PROMPT).toMatch(/CAN apply changes/);
    expect(PLATFORM_CAPABILITIES_PROMPT).toMatch(/Autonomous/);
    expect(PLATFORM_CAPABILITIES_PROMPT).toMatch(/Draft Pull Request/);
    expect(PLATFORM_CAPABILITIES_PROMPT).toMatch(/Never say you "cannot push"/);
  });
});
