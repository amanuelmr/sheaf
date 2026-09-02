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
  | { kind: 'connected'; protocol: string; documents: number; host: string };

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
  const [name, setName] = useState('');
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
      const host = url.replace(/^https?:\/\//, '');
      setPhase({
        kind: 'connected',
        protocol: result.value.protocol,
        documents: result.value.documents,
        host,
      });
      await connect({
        name: name.trim() === '' ? host : name.trim(),
        baseUrl: url,
        token: token.trim(),
      });
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
          {phase.host} · {phase.documents} {phase.documents === 1 ? 'document' : 'documents'}{' '}
          already there
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

      <Field
        label="Name"
        palette={palette}
        hint="Only shown once you have more than one server connected. Defaults to the address below."
      >
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Home"
          placeholderTextColor={palette.textMuted}
          autoCapitalize="words"
          autoCorrect={false}
          accessibilityLabel="Name for this server"
          style={[
            styles.input,
            { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
          ]}
        />
      </Field>

      <Field
        label="Server URL"
        palette={palette}
        hint="For example, 192.168.1.20:8787, or localhost:8787 in a simulator"
      >
        <TextInput
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder="http://localhost:8787"
          placeholderTextColor={palette.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="Server URL"
          style={[
            styles.input,
            { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
          ]}
        />
      </Field>

      <Field
        label="API token"
        palette={palette}
        hint="The SHEAF_TOKEN your server was started with. It is kept in this device’s keystore."
      >
        <TextInput
          value={token}
          onChangeText={setToken}
          placeholder="••••••••••••"
          placeholderTextColor={palette.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="Server token"
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
