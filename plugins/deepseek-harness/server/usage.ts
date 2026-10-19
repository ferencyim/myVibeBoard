import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  hashAccountKey,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server/usage";
import { parse } from "yaml";
import { z } from "zod";

const PROVIDER_ID = "deepseek-harness";
const KEY_NAME = "DEEPSEEK_API_KEY";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const FETCH_TIMEOUT_MS = 10_000;

const UsageInputSchema = z.object({ dshHome: z.string().min(1) }).strict();

const BalanceResponseSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(
    z.object({
      currency: z.string(),
      total_balance: z.string(),
      granted_balance: z.string(),
      topped_up_balance: z.string(),
    }),
  ),
});

export interface DeepSeekUsageOptions {
  /** The daemon environment; session scopes may override DSH_HOME. */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/**
 * Reports the DeepSeek API balance for the key DSH would use. The key is looked
 * up again on every fetch, in DSH's order: launch environment, the DSH
 * credential store, then `$DSH_HOME/.env`. It never leaves this process
 * except as the Authorization header of the balance request.
 */
export function createDeepSeekUsageSource(
  options: DeepSeekUsageOptions = {},
): UsageSourceRegistration {
  const env = options.env ?? process.env;
  const fetchBalance = options.fetch ?? fetch;

  return {
    id: "deepseek",
    label: "DeepSeek",
    icon: "icon.svg",
    input: UsageInputSchema,
    async discover(scope) {
      if (scope.kind === "session" && scope.provider !== PROVIDER_ID) {
        return [];
      }
      const dshHome = resolveDshHome(scopeHome(scope) ?? env.DSH_HOME);
      if (!(await resolveApiKey(env, dshHome))) {
        return [];
      }
      return [
        {
          // One DSH home is one login; the key itself may rotate.
          key: hashAccountKey(dshHome),
          label: "DeepSeek API",
          harness: "DeepSeek Harness",
          input: { dshHome },
        },
      ];
    },
    async fetch(input) {
      const { dshHome } = UsageInputSchema.parse(input);
      const key = await resolveApiKey(env, dshHome);
      if (!key) {
        return { status: "error", error: "No DeepSeek API key is configured for DSH." };
      }
      return fetchReport(fetchBalance, key);
    },
  };
}

async function fetchReport(
  fetchBalance: typeof fetch,
  key: string,
): Promise<UsageReport> {
  const response = await fetchBalance(BALANCE_URL, {
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    return { status: "unavailable", problem: { kind: "rejected", status: response.status } };
  }
  if (!response.ok) {
    return { status: "error", error: "DeepSeek balance request failed with HTTP " + response.status };
  }
  const body = BalanceResponseSchema.parse(await response.json());
  const tone = body.is_available ? "ok" : "danger";
  // Paseo balance units have no CNY, so every currency is reported as text.
  const details: UsageDetail[] = body.balance_infos.flatMap((info) => {
    const currency = info.currency.toLowerCase();
    const rows: UsageDetail[] = [
      {
        id: "balance-" + currency,
        label: "Balance",
        value: formatAmount(info.currency, info.total_balance),
        tone,
      },
    ];
    if (Number(info.granted_balance) > 0) {
      rows.push({
        id: "granted-" + currency,
        label: "Granted",
        value: formatAmount(info.currency, info.granted_balance),
      });
    }
    return rows;
  });
  if (!body.is_available && details.length === 0) {
    return { status: "unavailable", problem: { kind: "no_quota", detail: "Insufficient balance" } };
  }
  return { status: "available", windows: [], details };
}

function formatAmount(currency: string, amount: string): string {
  if (currency === "CNY") return "¥" + amount;
  if (currency === "USD") return "$" + amount;
  return amount + " " + currency;
}

function scopeHome(scope: UsageScope): string | undefined {
  return scope.kind === "session" ? scope.env.DSH_HOME : undefined;
}

function resolveDshHome(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return join(homedir(), ".dsh");
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

async function resolveApiKey(
  env: NodeJS.ProcessEnv,
  dshHome: string,
): Promise<string | undefined> {
  return (
    nonEmpty(env[KEY_NAME]) ??
    nonEmpty(await readStoredKey(join(dshHome, ".credentials.yaml"))) ??
    nonEmpty(await readEnvFileKey(join(dshHome, ".env")))
  );
}

async function readStoredKey(path: string): Promise<string | undefined> {
  const text = await readOptional(path);
  if (text === undefined) return undefined;
  // DSH's version-1 layout: `version: 1` with names under `refs`.
  const document: unknown = parse(text);
  if (!isRecord(document) || document.version !== 1 || !isRecord(document.refs)) {
    return undefined;
  }
  const value = document.refs[KEY_NAME];
  return typeof value === "string" ? value : undefined;
}

async function readEnvFileKey(path: string): Promise<string | undefined> {
  const text = await readOptional(path);
  return text === undefined ? undefined : parseEnv(text)[KEY_NAME];
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
