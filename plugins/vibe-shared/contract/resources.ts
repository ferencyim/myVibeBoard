/** SSH targets are passed as an argv entry; a leading dash must never become an option. */
export const REMOTE_TARGET_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.:-]*$/;
