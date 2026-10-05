import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { pairDevice } from '@sheaf/client';
import { describe as explainFailure } from '@sheaf/core';
import type { FetchLike } from '@sheaf/http';
import { useApp } from '../src/runtime/app-context';
import { spacing } from '../src/theme';
import { Button } from '../src/ui/components';

type Phase =
  | { kind: 'pairing' }
  | { kind: 'paired'; host: string }
  | { kind: 'failed'; title: string; body: string };

const transport: FetchLike = (url, init) => fetch(url, init as RequestInit);

/**
 * Pairing (ADR 0008). Reached from a `sheaf://pair?server=…&code=…` link, whether
 * the phone's own camera opened it from a QR code or Sheaf's scanner did. The code
 * becomes this phone's own token, kept in the keystore like any other.
 */
export default function Pair() {
  const { palette, connect } = useApp();
  const router = useRouter();
  const { server, code } = useLocalSearchParams<{ server?: string; code?: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'pairing' });
  // A code works once: never send it twice, even if the screen renders twice.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (server === undefined || code === undefined || !/^https?:\/\//.test(server)) {
      setPhase({
        kind: 'failed',
        title: 'That isn’t a Sheaf pairing code.',
        body: 'Open “Pair a phone” on your server and scan the code it shows.',
      });
      return;
    }
    const host = server.replace(/^https?:\/\//, '');
    const deviceName = Constants.deviceName ?? 'Phone';
    void pairDevice(server, transport, { code, deviceName }).then(async (result) => {
      if (!result.ok) {
        setPhase(
          result.reason.kind === 'rejected'
            ? {
                kind: 'failed',
                title: 'That code didn’t work.',
                body: 'Codes last five minutes and work once. Make a new one on your server and scan it again.',
              }
            : { kind: 'failed', ...explained(result.reason) },
        );
        return;
      }
      await connect({ name: host, baseUrl: server, token: result.value.token });
      setPhase({ kind: 'paired', host });
    });
  }, [server, code, connect]);

  return (
    <View style={[styles.centre, { backgroundColor: palette.background }]}>
      {phase.kind === 'pairing' ? (
        <>
          <ActivityIndicator color={palette.accent} />
          <Text style={[styles.body, { color: palette.textMuted }]}>Pairing with your server…</Text>
        </>
      ) : phase.kind === 'paired' ? (
        <>
          <Text style={[styles.title, { color: palette.text }]}>You’re ready.</Text>
          <Text style={[styles.body, { color: palette.textMuted }]}>
            This phone is paired with {phase.host}.
          </Text>
          <Button
            label="Scan your first document"
            palette={palette}
            onPress={() => router.replace('/')}
          />
        </>
      ) : (
        <>
          <Text style={[styles.title, { color: palette.text }]}>{phase.title}</Text>
          <Text style={[styles.body, { color: palette.textMuted }]}>{phase.body}</Text>
          <Button
            label="Back"
            variant="secondary"
            palette={palette}
            onPress={() => router.back()}
          />
        </>
      )}
    </View>
  );
}

function explained(reason: Parameters<typeof explainFailure>[0]): { title: string; body: string } {
  const { title, reassurance } = explainFailure(reason);
  return { title, body: reassurance };
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  title: { fontSize: 22, fontWeight: '600', textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
});
