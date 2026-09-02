import React from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useApp } from '../src/runtime/app-context';
import { releaseSyncedCopies } from '../src/adapters/files';
import { spacing, TOUCH_TARGET } from '../src/theme';
import { Button, Divider } from '../src/ui/components';

/**
 * Sensible defaults, and only the settings someone might actually want to change.
 * Everything expert-shaped stays out of the way.
 */
export default function Settings() {
  const {
    palette,
    settings,
    server,
    updateSetting,
    outbox,
    refresh,
    lockAvailable,
    profiles,
    activeProfileId,
    switchProfile,
    removeProfileById,
  } = useApp();
  const router = useRouter();
  const unsent = outbox.filter((row) => row.status !== 'SYNCED').length;
  const synced = outbox.filter((row) => row.status === 'SYNCED').length;

  const confirmRemove = (id: string, name: string) => {
    const active = id === activeProfileId;
    Alert.alert(
      `Remove ${name}?`,
      active && unsent > 0
        ? `${unsent} ${unsent === 1 ? 'document is' : 'documents are'} still waiting to sync to it. Removing keeps ${unsent === 1 ? 'it' : 'them'} on this device -- nothing captured through this server is deleted.`
        : 'Nothing captured through this server is deleted -- only the connection itself is forgotten.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void removeProfileById(id) },
      ],
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Section title="Servers" palette={palette}>
        {profiles.length === 0 ? (
          <Text style={[styles.value, { color: palette.text }]}>Not connected</Text>
        ) : (
          profiles.map((profile) => (
            <View key={profile.id} style={styles.profileRow}>
              <View style={styles.profileMain}>
                <Text style={[styles.value, { color: palette.text }]}>{profile.name}</Text>
                <Text style={[styles.hint, { color: palette.textMuted }]}>
                  {profile.baseUrl.replace(/^https?:\/\//, '')}
                  {profile.id === activeProfileId ? ' · active' : ''}
                </Text>
              </View>
              {profile.id === activeProfileId ? null : (
                <Button
                  label="Switch"
                  variant="secondary"
                  palette={palette}
                  onPress={() => void switchProfile(profile.id)}
                  style={styles.profileButton}
                />
              )}
              <Button
                label="Remove"
                variant="quiet"
                palette={palette}
                onPress={() => confirmRemove(profile.id, profile.name)}
                style={styles.profileButton}
              />
            </View>
          ))
        )}
        <Text style={[styles.hint, { color: palette.textMuted }]}>
          Documents go directly to whichever of these is active. Every token is held in this
          device’s keystore and never written to a log.
        </Text>
        <Button
          label={profiles.length === 0 ? 'Connect your server' : 'Add another server'}
          variant="secondary"
          palette={palette}
          onPress={() => router.push('/connect')}
        />
      </Section>

      {server === null ? null : (
        <>
          <Divider palette={palette} />
          <Section title="Library" palette={palette}>
            <Text style={[styles.hint, { color: palette.textMuted }]}>
              Search and edit everything your server already holds -- not just what this phone
              scanned.
            </Text>
            <Button
              label="Browse your documents"
              variant="secondary"
              palette={palette}
              onPress={() => router.push('/library')}
            />
          </Section>
        </>
      )}

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

      <Section title="Scanning" palette={palette}>
        <Text style={[styles.value, { color: palette.text }]}>{settings.dpi} dpi</Text>
        <Text style={[styles.hint, { color: palette.textMuted }]}>
          How large a page is assumed to be. Changing it changes how documents are identified, so a
          re-scan of something you already have would look like a new document rather than a
          duplicate.
        </Text>
      </Section>

      <Divider palette={palette} />

      <Section title="Storage" palette={palette}>
        <Text style={[styles.value, { color: palette.text }]}>
          {synced} on your server · {unsent} still here
        </Text>
        <Text style={[styles.hint, { color: palette.textMuted }]}>
          Local copies of documents your server has confirmed can be removed. Anything not yet
          confirmed is never touched.
        </Text>
        <Button
          label="Free up space"
          variant="secondary"
          palette={palette}
          disabled={synced === 0}
          onPress={() => {
            Alert.alert(
              'Remove local copies?',
              `${synced} ${synced === 1 ? 'document is' : 'documents are'} confirmed on your server and can be removed from this device. Documents still waiting will be kept.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Remove',
                  style: 'destructive',
                  onPress: () => {
                    const freed = releaseSyncedCopies(
                      outbox.filter((r) => r.status === 'SYNCED').map((r) => r.docId),
                    );
                    void refresh();
                    Alert.alert('Done', `Freed ${freed} local ${freed === 1 ? 'copy' : 'copies'}.`);
                  },
                },
              ],
            );
          }}
        />
      </Section>

      <Divider palette={palette} />

      <Section title="Security" palette={palette}>
        <Toggle
          label="Require Face ID or fingerprint"
          hint={
            lockAvailable
              ? 'Sheaf will ask before showing anything you have scanned.'
              : 'Set up Face ID, Touch ID or a fingerprint on this device to use this.'
          }
          value={settings.appLockEnabled && lockAvailable}
          disabled={!lockAvailable}
          onChange={(next) => void updateSetting('appLockEnabled', next)}
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
  disabled = false,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
  palette: { text: string; textMuted: string; accent: string };
  disabled?: boolean;
}) {
  return (
    <View style={[styles.toggleRow, disabled ? styles.toggleRowDisabled : null]}>
      <View style={styles.toggleMain}>
        <Text style={[styles.value, { color: palette.text }]}>{label}</Text>
        <Text style={[styles.hint, { color: palette.textMuted }]}>{hint}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
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
  toggleRowDisabled: { opacity: 0.5 },
  toggleMain: { flex: 1, gap: 2 },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  profileMain: { flex: 1, gap: 2 },
  profileButton: { minHeight: TOUCH_TARGET - 8, paddingHorizontal: spacing.md },
});
