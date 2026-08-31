import { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { ArchiveDocument, ArchiveVocabulary } from '@sheaf/protocol';
import {
  cacheOpenedDocument,
  getCachedDocument,
  starCachedDocument,
  type CachedDocument,
} from '../../src/adapters/archive-cache';
import { useApp } from '../../src/runtime/app-context';
import { radius, spacing, TOUCH_TARGET } from '../../src/theme';
import { Button, Chips, Divider, EmptyState, Field } from '../../src/ui/components';

type Load =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; source: 'live'; document: ArchiveDocument }
  | { kind: 'ready'; source: 'cache'; document: CachedDocument };

interface Display {
  readonly title: string;
  readonly created: string;
  readonly contentSnippet: string | null;
  readonly thumbnail: { readonly uri: string; readonly headers?: Record<string, string> } | null;
}

/**
 * One document from the archive. Online, this edits straight through to
 * Paperless -- unlike `document/[id].tsx`, there is no local event log entry
 * here, this was never captured on this phone, and a save either lands or it
 * does not, nothing queued. Offline, it falls back to whatever was cached the
 * last time this document was opened, read-only: there is nowhere for an edit
 * made offline to go, and pretending otherwise would be a save that silently
 * never happens.
 */
export default function ArchiveDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette, client, driver, offline } = useApp();

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [vocabulary, setVocabulary] = useState<ArchiveVocabulary | null>(null);
  const [title, setTitle] = useState('');
  const [correspondentId, setCorrespondentId] = useState<number | null>(null);
  const [documentTypeId, setDocumentTypeId] = useState<number | null>(null);
  const [tagIds, setTagIds] = useState<readonly number[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [starred, setStarred] = useState(false);
  const [starBusy, setStarBusy] = useState(false);

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
    if (documentId === null) return;
    let cancelled = false;

    async function loadFromCache(id: number): Promise<void> {
      if (driver === null) return;
      const cached = await getCachedDocument(driver, id);
      if (cancelled) return;
      if (cached === null) {
        setLoad({ kind: 'error' });
        return;
      }
      setLoad({ kind: 'ready', source: 'cache', document: cached });
      setStarred(cached.starred);
    }

    if (offline || client === null) {
      void loadFromCache(documentId);
      return () => {
        cancelled = true;
      };
    }

    void Promise.all([client.getArchiveDocument(documentId), client.archiveVocabulary()]).then(
      async ([documentResult, vocabResult]) => {
        if (cancelled) return;
        if (!documentResult.ok) {
          await loadFromCache(documentId);
          return;
        }
        const vocab = vocabResult.ok ? vocabResult.value : null;
        setVocabulary(vocab);
        setLoad({ kind: 'ready', source: 'live', document: documentResult.value });
        populate(documentResult.value, vocab);
        setStarred(false);

        // Best effort, and never blocks showing the document: the thumbnail
        // download this involves can be slow, and there is nothing to wait for.
        if (driver !== null) {
          await cacheOpenedDocument(
            driver,
            documentResult.value,
            client.archiveThumbnailSource(documentResult.value.id),
            Date.now(),
          );
          if (cancelled) return;
          const cached = await getCachedDocument(driver, documentResult.value.id);
          if (!cancelled && cached !== null) setStarred(cached.starred);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, driver, documentId, offline, populate]);

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
    if (!result.ok) return;
    setLoad({ kind: 'ready', source: 'live', document: result.value });
    setSaved(true);
    if (driver !== null) {
      await cacheOpenedDocument(
        driver,
        result.value,
        client.archiveThumbnailSource(result.value.id),
        Date.now(),
      );
    }
  };

  const toggleStar = async () => {
    if (driver === null || documentId === null || starBusy) return;
    setStarBusy(true);
    const next = !starred;
    await starCachedDocument(driver, documentId, next);
    setStarred(next);
    setStarBusy(false);
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
          body={
            offline
              ? "You're offline, and this document was not opened or starred before -- so there is nothing saved on this device to show."
              : 'It may have been removed from your server, or the connection dropped.'
          }
        />
      </View>
    );
  }

  const display: Display =
    load.source === 'live'
      ? {
          title: load.document.title,
          created: load.document.created,
          contentSnippet: load.document.contentSnippet,
          thumbnail: client === null ? null : client.archiveThumbnailSource(load.document.id),
        }
      : {
          title: load.document.title,
          created: load.document.created,
          contentSnippet: load.document.contentSnippet,
          thumbnail:
            load.document.thumbnailPath === null ? null : { uri: load.document.thumbnailPath },
        };

  const input = [
    styles.input,
    { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
  ];

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {load.source === 'cache' ? (
        <Text style={[styles.offlineNotice, { color: palette.waiting }]}>
          Offline — showing what was saved when this was last opened. Editing needs a connection.
        </Text>
      ) : null}

      <View style={styles.header}>
        {display.thumbnail === null ? null : (
          <Image
            source={display.thumbnail}
            style={[styles.thumb, { backgroundColor: palette.surfaceRaised }]}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        )}
        <View style={styles.headerText}>
          <Text style={[styles.heading, { color: palette.text }]} numberOfLines={3}>
            {display.title}
          </Text>
          <Text style={[styles.meta, { color: palette.textMuted }]}>{display.created}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              starred ? 'Starred for offline. Tap to unstar.' : 'Star for offline'
            }
            accessibilityState={{ disabled: starBusy }}
            disabled={starBusy}
            onPress={() => void toggleStar()}
            style={styles.starRow}
          >
            <Text style={[styles.star, { color: starred ? palette.waiting : palette.textMuted }]}>
              {starred ? '★ Starred for offline' : '☆ Star for offline'}
            </Text>
          </Pressable>
        </View>
      </View>

      {display.contentSnippet === null ? null : (
        <Text style={[styles.snippet, { color: palette.textMuted }]}>{display.contentSnippet}</Text>
      )}

      {load.source === 'cache' ? null : (
        <>
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
                      prev.includes(next)
                        ? prev.filter((tagId) => tagId !== next)
                        : [...prev, next],
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
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  offlineNotice: { fontSize: 13, lineHeight: 18, marginBottom: spacing.sm },
  header: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  headerText: { flex: 1, gap: spacing.xs },
  thumb: { width: 76, height: 100, borderRadius: radius.sm },
  heading: { fontSize: 20, fontWeight: '600' },
  meta: { fontSize: 13, lineHeight: 19 },
  starRow: { minHeight: TOUCH_TARGET - 12, justifyContent: 'center' },
  star: { fontSize: 14, fontWeight: '500' },
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
