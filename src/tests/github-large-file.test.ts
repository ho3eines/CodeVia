import { describe, expect, it, vi } from "vitest";
import { RealGitHubService } from "../github/real-service.js";

describe("RealGitHubService.getFile large-file handling", () => {
  it("reads raw GitHub contents when the response exceeds the Contents JSON limit", async () => {
    const content = `{"payload":"${"large-data".repeat(150_000)}"}\n`;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.github.raw+json");
      return new Response(content, {
        status: 200,
        headers: { "content-type": "application/vnd.github.raw" },
      });
    });
    const github = new RealGitHubService({ token: "test-token", fetchImpl });

    const file = await github.getFile({ owner: "acme", name: "backups" }, ".codevia/backups/records-0001.json", "main");

    expect(file?.content).toBe(content);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps decoding the JSON/base64 envelope used by older GitHub proxies", async () => {
    const content = "legacy small file\n";
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            path: "README.md",
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
            sha: "abc",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const github = new RealGitHubService({ token: "test-token", fetchImpl });

    await expect(github.getFile({ owner: "acme", name: "backups" }, "README.md", "main")).resolves.toEqual({
      path: "README.md",
      content,
      sha: "abc",
    });
  });

  it("infers base64 when a proxy strips the encoding field", async () => {
    const content = "proxy-stripped encoding field\n";
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ path: "README.md", content: Buffer.from(content).toString("base64"), sha: "proxy-blob" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const github = new RealGitHubService({ token: "test-token", fetchImpl });

    await expect(github.getFile({ owner: "acme", name: "backups" }, "README.md", "main")).resolves.toEqual({
      path: "README.md",
      content,
      sha: "proxy-blob",
    });
  });

  it("preserves raw JSON that merely has a content property", async () => {
    const content = '{"content":"this is user data, not a GitHub envelope"}\n';
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(content, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const github = new RealGitHubService({ token: "test-token", fetchImpl });

    await expect(github.getFile({ owner: "acme", name: "backups" }, "backup.json", "main")).resolves.toEqual({
      path: "backup.json",
      content,
    });
  });
});
