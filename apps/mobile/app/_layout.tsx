import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../src/runtime/app-context';
import { Button, EmptyState } from '../src/ui/components';
import { spacing } from '../src/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const { boot, bootError, palette, locked } = useApp();

  if (boot === 'starting') {
    // Deliberately quiet: opening a database is fast, and a splash screen with a
    // progress bar would only make it feel slower.
    return (
      <View style={[styles.centre, { backgroundColor: palette.background }]}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  if (boot === 'failed') {
    return (
      <View style={[styles.centre, { backgroundColor: palette.background }]}>
        <Text style={[styles.errorTitle, { color: palette.text }]}>
          Sheaf couldn’t open its local storage.
        </Text>
        <Text style={[styles.errorBody, { color: palette.textMuted }]}>
          No documents have been lost — nothing has been captured yet this session. Restarting the
          app usually clears this.
        </Text>
        <Text style={[styles.technical, { color: palette.textMuted }]}>{bootError}</Text>
      </View>
    );
  }

  if (locked) return <LockScreen />;

  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.background },
          headerTitleStyle: { color: palette.text, fontSize: 17 },
          headerTintColor: palette.accent,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: palette.background },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ title: 'Connect your server' }} />
        <Stack.Screen name="outbox" options={{ title: 'Outbox' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="document/[id]" options={{ title: 'Document' }} />
        <Stack.Screen name="library" options={{ title: 'Library' }} />
        <Stack.Screen name="archive/[id]" options={{ title: 'Document' }} />
      </Stack>
    </>
  );
}

/**
 * The one screen that stands between opening the app and seeing what has been
 * scanned. Prompts immediately rather than waiting for a tap -- the device's own
 * unlock is already a familiar interruption -- and stays here on cancel or
 * failure, with a button to try again rather than a way around it.
 */
function LockScreen() {
  const { palette, unlock } = useApp();

  useEffect(() => {
    // Deliberately an empty dependency array: `unlock`'s identity changes on every
    // context update, and depending on it would re-prompt on every one of them
    // rather than once per mount. This screen only (re)mounts when `locked`
    // becomes true, which is exactly when a fresh prompt is wanted.
    void unlock();
  }, []);

  return (
    <View style={[styles.centre, { backgroundColor: palette.background }]}>
      <EmptyState
        title="Sheaf is locked"
        body="Unlock this device to see what has been scanned."
        palette={palette}
        action={<Button label="Unlock" palette={palette} onPress={() => void unlock()} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  errorTitle: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  errorBody: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  technical: { fontSize: 12, fontFamily: 'Courier', textAlign: 'center' },
});
