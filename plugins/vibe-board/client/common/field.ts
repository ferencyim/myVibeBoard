// Pure helpers behind TextField (kept free of React / host imports so tests can load them).

/**
 * What a controlled text input should display. While the user is typing the local value is the only
 * truth: feeding the parent's (possibly stale or re-normalised) value back mid-edit makes the caret
 * jump on Android and desktop. When not focused, the parent's value wins so external changes show.
 */
export function displayedFieldValue(focused: boolean, local: string, external: string): string {
  return focused ? local : external;
}
