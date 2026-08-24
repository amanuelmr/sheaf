import React from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useApp } from '../src/runtime/app-context';
import { spacing } from '../src/theme';
import { Button, Divider } from '../src/ui/components';

/**
 * Sensible defaults, and only the settings someone might actually want to change.
 * Everything expert-shaped stays out of the way.
 */
export default function Settings() {
  const { palette, settings, server, updateSetting, disconnect, outbox } = useApp();
  const router = useRouter();
  const unsent = outbox.filter((row) => row.status !== 'SYNCED').length;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Section title="Server" palette={palette}>
        <Text style={[styles.value, { color: palette.text }]}>
          {server === null ? 'Not connected' : server.baseUrl.replace(/^https?:\/\//, '')}
        </Text>
        <Text style={[styles.hint, { color: palette.textMuted }]}>
          Your documents go directly here. The API token is held in this device’s keystore and is
          never written to a log.
        </Text>
        {server === null ? (
          <Button
            label="Connect your server"
            palette={palette}
            onPress={() => router.push('/connect')}
          />
        ) : (
          <Button
            label="Disconnect"
            variant="secondary"
            palette={palette}
            onPress={() => void disconnect()}
          />
        )}
        {unsent > 0 && server !== null ? (
          <Text style={[styles.hint, { color: palette.waiting }]}>
            {unsent} {unsent === 1 ? 'document is' : 'documents are'} still waiting to sync.
            Disconnecting keeps {unsent === 1 ? 'it' : 'them'} on this device.
          </Text>
        ) : null}
      </Section>

      <Divider palette={palette} />

      <Section title="Sync" palette={palette}>
        <Toggle
          label="Sync automatically"
          hint="When off, documents wait on this device until you open the outbox."
          value={settings.autoSync}
          onChange={(next) => void updateSetting('autoSync', next)}
          palette={palette}
        />
        <Toggle
          label="Wi-Fi only"
          hint="Documents still capture on mobile data; they just wait for Wi-Fi to upload."
          value={settings.wifiOnly}
          onChange={(next) => void updateSetting('wifiOnly', next)}
          palette={palette}
        />
        <Toggle
          label="Keep local copies after syncing"
          hint="On by default. Sheaf never deletes a document your server has not confirmed."
          value={settings.keepLocalAfterSync}
          onChange={(next) => void updateSetting('keepLocalAfterSync', next)}
          palette={palette}
        />
      </Section>

      <Divider palette={palette} />

      <Section title="Privacy" palette={palette}>
        <Text style={[styles.hint, { color: palette.textMuted }]}>
          Sheaf has no account and no backend. Nothing is collected, and no analytics are sent.
          Scans are stored on this device until your server confirms it has them.
        </Text>
      </Section>
    </ScrollView>
  );
}

function Section({
  title,
  palette,
  children,
}: {
  title: string;
  palette: { text: string; textMuted: string };
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: palette.textMuted }]}>{title}</Text>
      {children}
    </View>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
  palette,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
  palette: { text: string; textMuted: string; accent: string };
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleMain}>
        <Text style={[styles.value, { color: palette.text }]}>{label}</Text>
        <Text style={[styles.hint, { color: palette.textMuted }]}>{hint}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: palette.accent }}
        accessibilityLabel={label}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg },
  section: { gap: spacing.sm },
  sectionTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  value: { fontSize: 16, fontWeight: '500' },
  hint: { fontSize: 13, lineHeight: 19 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  toggleMain: { flex: 1, gap: 2 },
});
