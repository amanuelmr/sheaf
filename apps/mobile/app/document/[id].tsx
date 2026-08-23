import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { TrailEntry } from '@sheaf/store';
import { useApp } from '../../src/runtime/app-context';
import { clockTime, shortId } from '../../src/lib/format';
import { spacing } from '../../src/theme';

/**
 * The paper trail.
 *
 * Every capture app claims it never loses a document. Because the log is the source
 * of truth here, this screen can show the receipts instead — and it costs one query,
 * because the history already exists.
 */
export default function DocumentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette, store } = useApp();
  const [entries, setEntries] = useState<readonly TrailEntry[]>([]);

  useEffect(() => {
    if (store === null || id === undefined) return;
    void store.trail(id).then(setEntries);
  }, [store, id]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[styles.heading, { color: palette.text }]}>Scan {shortId(id ?? '')}</Text>
      <Text style={[styles.intro, { color: palette.textMuted }]}>
        Everything that has happened to this document, in order.
      </Text>

      <View style={styles.trail}>
        {entries.map((entry, index) => (
          <View key={`${entry.at}-${index}`} style={styles.entry}>
            <Text style={[styles.time, { color: palette.textMuted }]}>{clockTime(entry.at)}</Text>
            <Text
              style={[
                styles.text,
                { color: entry.notable ? palette.text : palette.textMuted },
                entry.notable ? styles.notable : null,
              ]}
            >
              {entry.text}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm },
  heading: { fontSize: 22, fontWeight: '600' },
  intro: { fontSize: 15, lineHeight: 21, marginBottom: spacing.md },
  trail: { gap: spacing.sm },
  entry: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  time: { fontSize: 12, fontFamily: 'Courier', width: 68 },
  text: { flex: 1, fontSize: 14, lineHeight: 20 },
  notable: { fontWeight: '600' },
});
