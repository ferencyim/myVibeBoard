import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeepSeekUsageSource } from "./usage";

let root = "";
let calls: { url: string; authorization: string | null }[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "paseo-deepseek-usage-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function home(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await writeFile(join(dir, file), text);
  }
  return dir;
}

function respond(status: number, body: unknown): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const cny = {
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "13.26", granted_balance: "0.00", topped_up_balance: "13.26" },
  ],
};

describe("DeepSeek usage source", () => {
  it("finds the key in DSH's order and keeps it out of the account", async () => {
    const dshHome = await home("order", {
      ".credentials.yaml": "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-stored\n",
      ".env": "DEEPSEEK_API_KEY=sk-dotenv\n",
    });
    calls = [];
    const fromStore = createDeepSeekUsageSource({ env: { DSH_HOME: dshHome }, fetch: respond(200, cny) });
    const [account] = await fromStore.discover({ kind: "global" });
    expect(account?.input).toEqual({ dshHome });
    expect(JSON.stringify(account)).not.toContain("sk-");
    await fromStore.fetch(account?.input);
    const fromEnv = createDeepSeekUsageSource({
      env: { DSH_HOME: dshHome, DEEPSEEK_API_KEY: "sk-env" },
      fetch: respond(200, cny),
    });
    await fromEnv.fetch({ dshHome });
    const dotenvHome = await home("dotenv", { ".env": "DEEPSEEK_API_KEY=sk-dotenv\n" });
    await fromStore.fetch({ dshHome: dotenvHome });
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer sk-stored",
      "Bearer sk-env",
      "Bearer sk-dotenv",
    ]);
    expect(calls[0]?.url).toBe("https://api.deepseek.com/user/balance");
  });

  it("discovers only DeepSeek Harness sessions, using the session DSH_HOME", async () => {
    const sessionHome = await home("session", {
      ".credentials.yaml": "version: 1\nrefs:\n  DEEPSEEK_API_KEY: 'sk-session'\n",
    });
    const source = createDeepSeekUsageSource({ env: { DSH_HOME: join(root, "missing") } });
    await expect(source.discover({ kind: "global" })).resolves.toEqual([]);
    await expect(
      source.discover({ kind: "session", provider: "codex", env: { DSH_HOME: sessionHome } }),
    ).resolves.toEqual([]);
    const accounts = await source.discover({
      kind: "session",
      provider: "deepseek-harness",
      env: { DSH_HOME: sessionHome },
    });
    expect(accounts.map((account) => account.input)).toEqual([{ dshHome: sessionHome }]);
  });

  it("ignores a store this build cannot read as DSH's version-1 layout", async () => {
    const flat = await home("flat", { ".credentials.yaml": "DEEPSEEK_API_KEY: sk-flat\n" });
    const source = createDeepSeekUsageSource({ env: { DSH_HOME: flat } });
    await expect(source.discover({ kind: "global" })).resolves.toEqual([]);
  });

  it("reports CNY and USD balances as text", async () => {
    const both = {
      is_available: true,
      balance_infos: [
        ...cny.balance_infos,
        { currency: "USD", total_balance: "5.00", granted_balance: "1.50", topped_up_balance: "3.50" },
      ],
    };
    const source = createDeepSeekUsageSource({ env: { DEEPSEEK_API_KEY: "sk" }, fetch: respond(200, both) });
    await expect(source.fetch({ dshHome: root })).resolves.toEqual({
      status: "available",
      windows: [],
      details: [
        { id: "balance-cny", label: "Balance", value: "¥13.26", tone: "ok" },
        { id: "balance-usd", label: "Balance", value: "$5.00", tone: "ok" },
        { id: "granted-usd", label: "Granted", value: "$1.50" },
      ],
    });
  });

  it("marks an exhausted balance and a rejected key", async () => {
    const empty = createDeepSeekUsageSource({
      env: { DEEPSEEK_API_KEY: "sk" },
      fetch: respond(200, { ...cny, is_available: false }),
    });
    const report = await empty.fetch({ dshHome: root });
    expect(report.status === "available" && report.details?.[0]?.tone).toBe("danger");
    const rejected = createDeepSeekUsageSource({
      env: { DEEPSEEK_API_KEY: "sk" },
      fetch: respond(401, { error: { message: "Authentication Fails" } }),
    });
    await expect(rejected.fetch({ dshHome: root })).resolves.toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401 },
    });
    await expect(rejected.fetch({ dshHome: root, key: "sk" })).rejects.toThrow();
  });
});
