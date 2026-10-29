import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export default function RoutinesRoute() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>例程</Text>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, padding: theme.spacing[6], backgroundColor: theme.colors.surface0 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.lg },
}));
