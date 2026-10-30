import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildStatus, releaseStatus } from "../server/dashboard";

const originalUrl = process.env.VIBE_CI_DASHBOARD_URL;
const servers: Server[] = [];

async function serve(status: number, body: unknown): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (originalUrl === undefined) {
    delete process.env.VIBE_CI_DASHBOARD_URL;
  } else {
    process.env.VIBE_CI_DASHBOARD_URL = originalUrl;
  }
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })),
  );
});

describe("dashboard HTTP 状态", () => {
  it("匹配主检出并隐藏失败原因中的凭据，透出旧发布数据", async () => {
    process.env.VIBE_CI_DASHBOARD_URL = await serve(200, {
      pipelines: [
        {
          repo: "/other",
          sourceRepo: "D:\\Repo\\Main\\",
          project: "app",
          failureReason: "token=secret-value Bearer another-secret",
        },
      ],
      products: [
        {
          id: "app",
          name: "App",
          repo: "d:/repo/main",
          status: "unreachable",
          stale: true,
          fetchedAt: "2026-10-30T00:00:00Z",
          items: [],
        },
      ],
    });
    const build = await buildStatus(".", "d:/repo/main");
    expect(build.status).toBe("ok");
    expect(build.pipelines).toHaveLength(1);
    expect(build.pipelines[0].failureReason).toContain("[已隐藏]");
    expect(build.pipelines[0].failureReason).not.toContain("secret-value");
    expect(build.pipelines[0].failureReason).not.toContain("another-secret");
    const release = await releaseStatus("D:\\Repo\\Main");
    expect(release.status).toBe("ok");
    expect(release.products[0]).toMatchObject({
      status: "unreachable",
      stale: true,
      fetchedAt: "2026-10-30T00:00:00Z",
    });
  });

  it("未匹配时返回 not_configured", async () => {
    process.env.VIBE_CI_DASHBOARD_URL = await serve(200, {
      pipelines: [{ repo: "/other" }],
      products: [{ repo: "/other" }],
    });
    expect((await buildStatus(".", "/main")).status).toBe("not_configured");
    expect((await releaseStatus("/main")).status).toBe("not_configured");
  });

  it("非 200 返回 error", async () => {
    process.env.VIBE_CI_DASHBOARD_URL = await serve(503, {});
    expect((await buildStatus(".", "/main")).status).toBe("error");
    expect((await releaseStatus("/main")).status).toBe("error");
  });

  it("连接失败返回 dashboard_down", async () => {
    const url = await serve(200, {});
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    process.env.VIBE_CI_DASHBOARD_URL = url;
    expect((await buildStatus(".", "/main")).status).toBe("dashboard_down");
    expect((await releaseStatus("/main")).status).toBe("dashboard_down");
  });
});
