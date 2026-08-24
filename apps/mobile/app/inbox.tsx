import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { DocState, Suggestions } from '@sheaf/core';
import { useApp } from '../src/runtime/app-context';
import { spacing } from '../src/theme';
import { Button, Divider, EmptyState } from '../src/ui/components';

/**
 * Filing, after the fact.
 *
 * These documents are already in Paperless. Nothing here is blocking anything, and
 * the suggestions come from Paperless's own classifier — trained on this user's
 * corpus, which no on-device guess can match. Accepting is one tap; ignoring the
 * screen entirely is also fine.
 */
export default function Inbox() {
  const { palette, store, accept, outbox } = useApp();
  const [pending, setPending] = useState<readonly DocState[]>([]);

  useEffect(() => {
    if (store === null) return;
    void store.states().then((states) => {
      setPending(
        [...states.values()].filter(
          (state) =>
            state.status === 'SYNCED' &&
            state.remoteId !== null &&
            state.suggestions !== null &&
            state.metadata === null,
        ),
      );
    });
  }, [store, outbox]);

  return (
    <ScrollView contentContainerStyle={pending.length === 0 ? styles.empty : styles.content}>
      {pending.length === 0 ? (
        <EmptyState
          palette={palette}
          title="Nothing to file."
          body="Documents already on your server show up here when there is something to suggest."
        />
      ) : (
        pending.map((state) => (
          <View key={state.docId} style={styles.card}>
            <Text style={[styles.docTitle, { color: palette.text }]}>
              Document #{state.remoteId}
            </Text>
            <SuggestionList suggestions={state.suggestions} palette={palette} />
            <View style={styles.actions}>
              <Button
                label="Accept"
                palette={palette}
                onPress={() => void accept(state.docId, patchFor(state.suggestions))}
                style={styles.action}
              />
              <Button
                label="Skip"
                variant="secondary"
                palette={palette}
                onPress={() => setPending(pending.filter((row) => row.docId !== state.docId))}
                style={styles.action}
              />
            </View>
            <Divider palette={palette} />
          </View>
        ))
      )}
    </ScrollView>
  );
}

function SuggestionList({
  suggestions,
  palette,
}: {
  suggestions: Suggestions | null;
  palette: { text: string; textMuted: string };
}) {
  if (suggestions === null) return null;
  const rows: Array<[string, string]> = [];
  if (suggestions.correspondent !== undefined) rows.push(['From', suggestions.correspondent]);
  if (suggestions.documentType !== undefined) rows.push(['Type', suggestions.documentType]);
  if (suggestions.date !== undefined) rows.push(['Date', suggestions.date]);
  if (suggestions.tags !== undefined && suggestions.tags.length > 0) {
    rows.push(['Tags', suggestions.tags.join(', ')]);
  }

  if (rows.length === 0) {
    return <Text style={[styles.none, { color: palette.textMuted }]}>No suggestions yet.</Text>;
  }

  return (
    <View style={styles.suggestions}>
      <Text style={[styles.suggestedLabel, { color: palette.textMuted }]}>Suggested</Text>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.suggestionRow}>
          <Text style={[styles.suggestionKey, { color: palette.textMuted }]}>{label}</Text>
          <Text style={[styles.suggestionValue, { color: palette.text }]}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Only the title is applied for now. Correspondent, type and tags are ids on the
 * server, and applying them means resolving names back to ids — which needs the
 * vocabulary cache and belongs with the editing screen, not here.
 */
function patchFor(suggestions: Suggestions | null) {
  if (suggestions === null) return {};
  const title = suggestions.correspondent ?? suggestions.documentType;
  return title === undefined ? {} : { title };
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg },
  empty: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  card: { gap: spacing.sm },
  docTitle: { fontSize: 17, fontWeight: '600' },
  suggestions: { gap: spacing.xs },
  suggestedLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontWeight: '600',
  },
  suggestionRow: { flexDirection: 'row', gap: spacing.md },
  suggestionKey: { fontSize: 14, width: 56 },
  suggestionValue: { fontSize: 15, flex: 1 },
  none: { fontSize: 14 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  action: { flex: 1 },
});
