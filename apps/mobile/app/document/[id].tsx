import { useCallback, useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { DocState, MetadataPatch } from '@sheaf/core';
import type { TrailEntry } from '@sheaf/store';
import { useApp } from '../../src/runtime/app-context';
import { clockTime, formatBytes, pageLabel, shortId, timeAgo } from '../../src/lib/format';
import { radius, spacing, TOUCH_TARGET } from '../../src/theme';
import { Button, Divider, Field } from '../../src/ui/components';

/**
 * Everything about one document: what it looks like, what it is called, and an
 * honest account of where it has been.
 *
 * The details are editable here rather than in a step between the shutter and
 * safety. The document is already stored and already on its way before this screen
 * is ever opened, so nothing typed here can delay or endanger it — which is the
 * distinction ADR 0003 is actually about.
 */
export default function DocumentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette, store, accept, retry, outbox } = useApp();

  const [state, setState] = useState<DocState | null>(null);
  const [entries, setEntries] = useState<readonly TrailEntry[]>([]);
  const [title, setTitle] = useState('');
  const [correspondent, setCorrespondent] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [tags, setTags] = useState('');
  const [saved, setSaved] = useState(false);

  const row = outbox.find((r) => r.docId === id) ?? null;

  const load = useCallback(async () => {
    if (store === null || id === undefined) return;
    const [next, trail] = await Promise.all([store.state(id), store.trail(id)]);
    setState(next);
    setEntries(trail);
    if (next !== null) {
      const m = next.metadata ?? {};
      const s = next.suggestions ?? {};
      setTitle(m.title ?? s.title ?? '');
      setCorrespondent(m.correspondent ?? s.correspondent ?? '');
      setDocumentType(m.documentType ?? s.documentType ?? '');
      setTags((m.tags ?? s.tags ?? []).join(', '));
    }
  }, [store, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (id === undefined) return;
    // Only send fields that were actually filled in. Sending an empty string would
    // clear something the user never touched.
    const patch: MetadataPatch = {
      ...(title.trim() === '' ? {} : { title: title.trim() }),
      ...(correspondent.trim() === '' ? {} : { correspondent: correspondent.trim() }),
      ...(documentType.trim() === '' ? {} : { documentType: documentType.trim() }),
      ...(tags.trim() === ''
        ? {}
        : {
            tags: tags
              .split(',')
              .map((t) => t.trim())
              .filter((t) => t !== ''),
          }),
    };
    await accept(id, patch);
    setSaved(true);
    await load();
  };

  const input = [
    styles.input,
    { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
  ];

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        {state?.thumbnailPath == null ? (
          <View style={[styles.thumbFallback, { backgroundColor: palette.surfaceRaised }]} />
        ) : (
          <Image
            source={{ uri: state.thumbnailPath }}
            style={[styles.thumb, { backgroundColor: palette.surfaceRaised }]}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        )}
        <View style={styles.headerText}>
          <Text style={[styles.heading, { color: palette.text }]} numberOfLines={2}>
            {title === '' ? `Scan ${shortId(id ?? '')}` : title}
          </Text>
          {state === null ? null : (
            <Text style={[styles.meta, { color: palette.textMuted }]}>
              {pageLabel(state.pages.length)} · {formatBytes(state.bytes)} ·{' '}
              {timeAgo(state.createdAt, Date.now())}
            </Text>
          )}
          {row === null ? null : (
            <Text style={[styles.meta, { color: palette.textMuted }]}>
              {row.symbol} {row.label}
            </Text>
          )}
        </View>
      </View>

      {row?.actionable === true ? (
        <Button
          label="Try again"
          variant="secondary"
          palette={palette}
          onPress={() => void retry(id ?? '')}
        />
      ) : null}

      <Divider palette={palette} />

      <Text style={[styles.sectionTitle, { color: palette.textMuted }]}>Details</Text>
      <Field label="Title" palette={palette}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Amazon receipt"
          placeholderTextColor={palette.textMuted}
          accessibilityLabel="Document title"
          style={input}
        />
      </Field>
      <Field label="From" palette={palette}>
        <TextInput
          value={correspondent}
          onChangeText={setCorrespondent}
          placeholder="Who it is from"
          placeholderTextColor={palette.textMuted}
          accessibilityLabel="Correspondent"
          style={input}
        />
      </Field>
      <Field label="Type" palette={palette}>
        <TextInput
          value={documentType}
          onChangeText={setDocumentType}
          placeholder="Receipt, invoice, letter…"
          placeholderTextColor={palette.textMuted}
          accessibilityLabel="Document type"
          style={input}
        />
      </Field>
      <Field label="Tags" palette={palette} hint="Separated by commas">
        <TextInput
          value={tags}
          onChangeText={setTags}
          placeholder="shopping, electronics"
          placeholderTextColor={palette.textMuted}
          accessibilityLabel="Tags"
          autoCapitalize="none"
          style={input}
        />
      </Field>

      <Button
        label={saved ? 'Saved' : 'Save details'}
        palette={palette}
        onPress={() => void save()}
      />
      {state !== null && state.metadata !== null && !state.metadataPatched ? (
        <Text style={[styles.meta, { color: palette.textMuted }]}>
          Waiting to send these to your server. The document itself is already there.
        </Text>
      ) : null}

      <Divider palette={palette} />

      <Text style={[styles.sectionTitle, { color: palette.textMuted }]}>History</Text>
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
  header: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  headerText: { flex: 1, gap: spacing.xs },
  thumb: { width: 76, height: 100, borderRadius: radius.sm },
  thumbFallback: { width: 76, height: 100, borderRadius: radius.sm },
  heading: { fontSize: 20, fontWeight: '600' },
  meta: { fontSize: 13, lineHeight: 19 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: spacing.sm,
  },
  intro: { fontSize: 14, lineHeight: 20, marginBottom: spacing.sm },
  input: {
    minHeight: TOUCH_TARGET,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  trail: { gap: spacing.sm },
  entry: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  time: { fontSize: 12, fontFamily: 'Courier', width: 68 },
  text: { flex: 1, fontSize: 14, lineHeight: 20 },
  notable: { fontWeight: '600' },
});
