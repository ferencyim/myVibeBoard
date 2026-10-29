export interface AvatarIdentityOptions {
  seed: string;
  name: string;
  hue?: number;
}

export function avatarInitial(name: string): string {
  const firstCharacter = Array.from(name.trim())[0];
  return firstCharacter ? firstCharacter.toLocaleUpperCase("en-US") : "?";
}

export function avatarHue(seed: string, hue?: number): number {
  if (hue !== undefined && Number.isFinite(hue)) {
    return ((hue % 360) + 360) % 360;
  }
  let hash = 2166136261;
  for (const character of seed) {
    const codePoint = character.codePointAt(0)!;
    hash = Math.imul(hash ^ codePoint, 16777619) >>> 0;
  }
  return hash % 360;
}

export function avatarIdentity({ seed, name, hue }: AvatarIdentityOptions) {
  const resolvedHue = avatarHue(seed, hue);
  return {
    initial: avatarInitial(name),
    hue: resolvedHue,
    backgroundColor: `hsl(${resolvedHue}, 48%, 32%)`,
  };
}
