import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { describe as explainFailure } from '@sheaf/core';
import { createClient } from '../src/adapters/api';
import { useApp } from '../src/runtime/app-context';
import { radius, spacing, TOUCH_TARGET } from '../src/theme';
import { Button, Field } from '../src/ui/components';

type Phase =
  | { kind: 'editing' }
  | { kind: 'testing' }
  | { kind: 'failed'; title: string; reassurance: string; technical: string }
  | { kind: 'connected'; version: string | null; host: string };

/**
 * The whole of onboarding: two fields and a button.
 *
 * Nothing else is asked. Default correspondent, compression, sync interval, OCR
 * engine — none of that needs deciding before the first scan, so none of it is
 * asked for (§40).
 */
export default function Connect() {
  const { palette, connect } = useApp();
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const [showTechnical, setShowTechnical] = useState(false);

  const test = async () => {
    const trimmed = baseUrl.trim().replace(/\/+$/, '');
    const url = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    setPhase({ kind: 'testing' });
    const result = await createClient({ baseUrl: url, token: token.trim() }).testConnection();
    if (result.ok) {
      setPhase({ kind: 'connected', version: result.value.version, host: result.value.host });
      await connect({ baseUrl: url, token: token.trim() });
      return;
    }
    // The status code is never what a user is shown first.
    const explained = explainFailure(result.reason);
    setPhase({
      kind: 'failed',
      title: explained.title,
      reassurance: explained.reassurance,
      technical: explained.technical,
    });
  };

  if (phase.kind === 'connected') {
    return (
      <View style={styles.done}>
        <Text style={[styles.doneTitle, { color: palette.text }]}>You’re ready.</Text>
        <Text style={[styles.doneBody, { color: palette.textMuted }]}>
          {phase.host}
          {phase.version === null ? '' : ` · Paperless ${phase.version}`}
        </Text>
        <Button
          label="Scan your first document"
          palette={palette}
          onPress={() => router.replace('/')}
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={[styles.lede, { color: palette.textMuted }]}>
        Sheaf sends your documents straight to your own Paperless server. There is no account, and
        nothing is stored anywhere else.
      </Text>

      <Field label="Server URL" palette={palette} hint="For example, paperless.example.com">
        <TextInput
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder="https://paperless.example.com"
          placeholderTextColor={palette.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="Paperless server URL"
          style={[
            styles.input,
            { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
          ]}
        />
      </Field>

      <Field
        label="API token"
        palette={palette}
        hint="In Paperless: your profile, then API token. It is kept in this device’s keystore."
      >
        <TextInput
          value={token}
          onChangeText={setToken}
          placeholder="••••••••••••"
          placeholderTextColor={palette.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="Paperless API token"
          style={[
            styles.input,
            { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
          ]}
        />
      </Field>

      <Button
        label={phase.kind === 'testing' ? 'Testing…' : 'Test connection'}
        palette={palette}
        disabled={phase.kind === 'testing' || baseUrl.trim() === '' || token.trim() === ''}
        onPress={() => void test()}
      />

      {phase.kind === 'failed' ? (
        <View
          style={[styles.error, { borderColor: palette.border, backgroundColor: palette.surface }]}
        >
          <Text style={[styles.errorTitle, { color: palette.text }]}>{phase.title}</Text>
          <Text style={[styles.errorBody, { color: palette.textMuted }]}>{phase.reassurance}</Text>
          <Button
            label={showTechnical ? 'Hide details' : 'Advanced details'}
            variant="quiet"
            palette={palette}
            onPress={() => setShowTechnical(!showTechnical)}
          />
          {showTechnical ? (
            <Text style={[styles.technical, { color: palette.textMuted }]}>{phase.technical}</Text>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm },
  lede: { fontSize: 15, lineHeight: 22, marginBottom: spacing.lg },
  input: {
    minHeight: TOUCH_TARGET + 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  error: {
    marginTop: spacing.lg,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    gap: spacing.xs,
  },
  errorTitle: { fontSize: 16, fontWeight: '600' },
  errorBody: { fontSize: 14, lineHeight: 20 },
  technical: { fontSize: 12, fontFamily: 'Courier' },
  done: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  doneTitle: { fontSize: 26, fontWeight: '600' },
  doneBody: { fontSize: 15, marginBottom: spacing.lg },
});
