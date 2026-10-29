import { useCallback, useMemo, useState } from "react";
import { Image, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { avatarIdentity } from "./avatar-identity";

export interface AvatarProps {
  seed: string;
  name: string;
  uri?: string;
  hue?: number;
  size?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function Avatar({
  seed,
  name,
  uri,
  hue,
  size = 36,
  accessibilityLabel = name,
  style,
}: AvatarProps) {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const identity = avatarIdentity({ seed, name, hue });
  const hasImage = Boolean(uri) && uri !== failedUri;
  const imageSource = useMemo(() => ({ uri }), [uri]);
  const imageFailed = useCallback(() => setFailedUri(uri ?? null), [uri]);
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.circle,
        { width: size, height: size, backgroundColor: identity.backgroundColor },
        style,
      ]}
    >
      {hasImage ? (
        <Image source={imageSource} style={styles.image} onError={imageFailed} />
      ) : (
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.42), lineHeight: size }]}>
          {identity.initial}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  circle: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    overflow: "hidden",
    flexShrink: 0,
  },
  image: { width: "100%", height: "100%" },
  initial: {
    color: "#ffffff",
    fontFamily: theme.fontFamily.ui,
    fontWeight: theme.fontWeight.semibold,
  },
}));
