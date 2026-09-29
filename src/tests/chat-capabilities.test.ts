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

import { looksLikeChangeRequest } from "../http/routes/conversations.js";

describe("chat change-request detection (offers the Apply button)", () => {
  it("detects English and Persian change requests", () => {
    expect(looksLikeChangeRequest("Add Serilog to Program.cs")).toBe(true);
    expect(looksLikeChangeRequest("لاگ Serilog رو به Program.cs اضافه کن")).toBe(true);
    expect(looksLikeChangeRequest("میتونی در پروژه تغییرات اعمال کنی؟")).toBe(true);
  });
  it("ignores plain questions", () => {
    expect(looksLikeChangeRequest("What does DbService do?")).toBe(false);
    expect(looksLikeChangeRequest("این پروژه چه ساختاری دارد؟")).toBe(false);
  });
});
