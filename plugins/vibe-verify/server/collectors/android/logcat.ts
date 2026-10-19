// Parse a `logcat -d -v threadtime` dump for crashes of one package.

export type CrashKind = "java" | "anr" | "native";

export interface CrashFinding {
  kind: CrashKind;
  line: string;
  /** First few lines starting at the match. */
  excerpt: string[];
}

export interface LogcatAnalysis {
  crashes: CrashFinding[];
  /** Count of `ReactNativeJS` error-level lines (not a crash; reported as a note). */
  jsErrors: number;
}

const NATIVE_LOOKAHEAD = 12;

export function analyzeLogcat(text: string, packageName: string): LogcatAnalysis {
  const lines = text.split(/\r?\n/);
  const crashes: CrashFinding[] = [];
  let jsErrors = 0;
  const pkg = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const processRe = new RegExp(`Process: ${pkg}(,|\\s|$)`);
  const anrRe = new RegExp(`ANR in ${pkg}(\\s|\\(|$)`);
  const nativeRe = new RegExp(`>>> ${pkg}\\b`);
  const near = (i: number, re: RegExp, span: number) =>
    lines.slice(i, i + span).some((l) => re.test(l));
  const excerptAt = (i: number) => lines.slice(i, i + 6).map((l) => l.trim());

  lines.forEach((line, i) => {
    if (/\bE ReactNativeJS\b/.test(line)) jsErrors++;
    if (/FATAL EXCEPTION/.test(line) && near(i, processRe, 4)) {
      crashes.push({ kind: "java", line: line.trim(), excerpt: excerptAt(i) });
    } else if (anrRe.test(line)) {
      crashes.push({ kind: "anr", line: line.trim(), excerpt: excerptAt(i) });
    } else if (/Fatal signal \d+/.test(line) && near(i, nativeRe, NATIVE_LOOKAHEAD)) {
      crashes.push({ kind: "native", line: line.trim(), excerpt: excerptAt(i) });
    }
  });
  return { crashes, jsErrors };
}
