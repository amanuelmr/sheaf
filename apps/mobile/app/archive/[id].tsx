import { useCallback, useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { ArchiveDocument, ArchiveVocabulary } from '@sheaf/protocol';
import { useApp } from '../../src/runtime/app-context';
import { radius, spacing, TOUCH_TARGET } from '../../src/theme';
import { Button, Chips, Divider, EmptyState, Field } from '../../src/ui/components';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; document: ArchiveDocument };

/**
 * One document from the archive, edited directly against Paperless. Unlike
 * `document/[id].tsx`, there is no local event log entry here -- this was never
 * captured on this phone, there is nothing to queue, and a save either lands or
 * it does not.
 */
export default function ArchiveDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette, client } = useApp();

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [vocabulary, setVocabulary] = useState<ArchiveVocabulary | null>(null);
  const [title, setTitle] = useState('');
  const [correspondentId, setCorrespondentId] = useState<number | null>(null);
  const [documentTypeId, setDocumentTypeId] = useState<number | null>(null);
  const [tagIds, setTagIds] = useState<readonly number[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const documentId = id === undefined ? null : Number(id);

  const populate = useCallback((document: ArchiveDocument, vocab: ArchiveVocabulary | null) => {
    setTitle(document.title);
    setCorrespondentId(
      vocab === null
        ? null
        : (vocab.correspondents.find((c) => c.name === document.correspondent)?.id ?? null),
    );
    setDocumentTypeId(
      vocab === null
        ? null
        : (vocab.documentTypes.find((t) => t.name === document.documentType)?.id ?? null),
    );
    setTagIds(
      vocab === null
        ? []
        : vocab.tags.filter((t) => document.tags.includes(t.name)).map((t) => t.id),
    );
  }, []);

  useEffect(() => {
    if (client === null || documentId === null) return;
    let cancelled = false;
    void Promise.all([client.getArchiveDocument(documentId), client.archiveVocabulary()]).then(
      ([documentResult, vocabResult]) => {
        if (cancelled) return;
        const vocab = vocabResult.ok ? vocabResult.value : null;
        setVocabulary(vocab);
        if (!documentResult.ok) {
          setLoad({ kind: 'error' });
          return;
        }
        setLoad({ kind: 'ready', document: documentResult.value });
        populate(documentResult.value, vocab);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, documentId, populate]);

  const save = async () => {
    if (client === null || documentId === null) return;
    setSaving(true);
    const result = await client.patchArchiveDocument(documentId, {
      title: title.trim(),
      correspondentId,
      documentTypeId,
      tagIds,
    });
    setSaving(false);
    if (result.ok) {
      setLoad({ kind: 'ready', document: result.value });
      setSaved(true);
    }
  };

  if (load.kind === 'loading') {
    return (
      <View style={[styles.centre, { backgroundColor: palette.background }]}>
        <Text style={{ color: palette.textMuted }}>Loading…</Text>
      </View>
    );
  }

  if (load.kind === 'error' || documentId === null) {
    return (
      <View style={[styles.centre, { backgroundColor: palette.background }]}>
        <EmptyState
          palette={palette}
          title="Couldn't load this document."
          body="It may have been removed from your server, or the connection dropped."
        />
      </View>
    );
  }

  const input = [
    styles.input,
    { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
  ];

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        {client === null ? null : (
          <Image
            source={client.archiveThumbnailSource(load.document.id)}
            style={[styles.thumb, { backgroundColor: palette.surfaceRaised }]}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        )}
        <View style={styles.headerText}>
          <Text style={[styles.heading, { color: palette.text }]} numberOfLines={3}>
            {load.document.title}
          </Text>
          <Text style={[styles.meta, { color: palette.textMuted }]}>{load.document.created}</Text>
        </View>
      </View>

      {load.document.contentSnippet === null ? null : (
        <Text style={[styles.snippet, { color: palette.textMuted }]}>
          {load.document.contentSnippet}
        </Text>
      )}

      <Divider palette={palette} />

      <Text style={[styles.sectionTitle, { color: palette.textMuted }]}>Details</Text>
      <Field label="Title" palette={palette}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholderTextColor={palette.textMuted}
          accessibilityLabel="Document title"
          style={input}
        />
      </Field>

      {vocabulary === null ? null : (
        <>
          <Field label="Correspondent" palette={palette}>
            <Chips
              entries={vocabulary.correspondents}
              selectedIds={correspondentId === null ? [] : [correspondentId]}
              onToggle={(next) => setCorrespondentId(correspondentId === next ? null : next)}
              palette={palette}
              label="Correspondent"
            />
          </Field>
          <Field label="Type" palette={palette}>
            <Chips
              entries={vocabulary.documentTypes}
              selectedIds={documentTypeId === null ? [] : [documentTypeId]}
              onToggle={(next) => setDocumentTypeId(documentTypeId === next ? null : next)}
              palette={palette}
              label="Document type"
            />
          </Field>
          <Field label="Tags" palette={palette}>
            <Chips
              entries={vocabulary.tags}
              selectedIds={tagIds}
              onToggle={(next) =>
                setTagIds((prev) =>
                  prev.includes(next) ? prev.filter((id) => id !== next) : [...prev, next],
                )
              }
              palette={palette}
              label="Tags"
            />
          </Field>
        </>
      )}

      <Button
        label={saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
        palette={palette}
        disabled={saving}
        onPress={() => void save()}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  header: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  headerText: { flex: 1, gap: spacing.xs },
  thumb: { width: 76, height: 100, borderRadius: radius.sm },
  heading: { fontSize: 20, fontWeight: '600' },
  meta: { fontSize: 13, lineHeight: 19 },
  snippet: { fontSize: 14, lineHeight: 20 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: spacing.sm,
  },
  input: {
    minHeight: TOUCH_TARGET,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
});
