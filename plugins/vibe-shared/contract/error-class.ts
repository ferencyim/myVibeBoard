// Failure classifier (WP-84): turns the error text of a failed turn / failed agent start into a
// category. Paseo providers report plain strings (`outcome.error.message`, `agent.lastError`), so
// this is a pattern table; add a rule to RULES when a provider words a failure differently.
//
// Only categories in REASSIGNABLE justify moving the work to another preset: the failure comes
// from the provider/account, not from the task, so another provider can plausibly succeed.

export type FailureCategory =
  | "quota" // usage / credit / spend limit exhausted
  | "auth" // login expired, invalid or missing credentials
  | "model" // model does not exist / not allowed for this account
  | "unavailable" // provider binary missing, service down, overloaded, network
  | "other";

export const REASSIGNABLE: ReadonlySet<FailureCategory> = new Set([
  "quota",
  "auth",
  "model",
  "unavailable",
]);

interface Rule {
  category: FailureCategory;
  pattern: RegExp;
}

// Order matters: the first matching rule wins (quota before the generic 429/overloaded rule).
const RULES: Rule[] = [
  {
    category: "quota",
    pattern:
      /usage limit|limit reached|hit your (?:usage )?limit|out of (?:credits?|usage)|credit balance|insufficient[_ ](?:quota|credits?|funds)|quota (?:exceeded|exhausted)|exceeded your (?:current )?quota|billing|spend(?:ing)? limit|rate[_ ]limit(?:ed)? .*(?:weekly|daily|5-hour)|resource_exhausted|upgrade (?:your )?plan/i,
  },
  {
    category: "auth",
    pattern:
      /\/login|not logged in|log ?in required|login (?:expired|required|failed)|please (?:log ?in|sign ?in)|unauthori[sz]ed|\b401\b|invalid[_ ](?:api[_ ]?key|x-api-key|token|credentials)|authentication[_ ](?:failed|error|required)|token (?:has )?expired|expired token|oauth|forbidden|\b403\b|api key (?:is )?(?:missing|not set)/i,
  },
  {
    category: "model",
    pattern:
      /model[^.\n]{0,60}(?:not found|does not exist|not supported|unavailable|not available|invalid|unknown|not allowed|no access)|(?:invalid|unknown|unsupported) model|selected model|issue with the selected model|no such model|model_not_found/i,
  },
  {
    category: "unavailable",
    pattern:
      /provider[^.\n]{0,40}(?:unavailable|not (?:installed|available|found)|disabled)|command not found|enoent|spawn .* (?:failed|enoent)|executable .*not found|not installed|overloaded|rate[_ ]limit|\b(?:429|500|502|503|504|529)\b|service unavailable|temporarily unavailable|econnrefused|econnreset|etimedout|enotfound|network error|socket hang up|stream disconnected|failed to (?:start|launch|spawn)|exited with code|process exited|too many requests/i,
  },
];

export function classifyFailure(message: string | undefined | null, code?: string): FailureCategory {
  const text = `${code ?? ""} ${message ?? ""}`;
  for (const rule of RULES) if (rule.pattern.test(text)) return rule.category;
  return "other";
}

export const isReassignable = (category: FailureCategory) => REASSIGNABLE.has(category);

export function isModelUnavailableError(error: unknown): boolean {
  let message: string;
  if (error instanceof Error) message = error.message;
  else if (typeof error === "string") message = error;
  else return false;
  return isReassignable(classifyFailure(message));
}
