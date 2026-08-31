import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ArchiveDocument, ArchiveVocabulary } from '@sheaf/protocol';
import { useApp } from '../src/runtime/app-context';
import { Chips, EmptyState } from '../src/ui/components';
import { spacing, radius, TOUCH_TARGET } from '../src/theme';

const DEBOUNCE_MS = 300;

/**
 * Everything your server already holds, not just what this phone captured —
 * fetched live from Paperless every time, never cached here. See
 * `ArchiveDocument` in `@sheaf/protocol` for why: a second, possibly-stale copy
 * of your archive is exactly the duplication the rest of this protocol avoids.
 */
export default function Library() {
  const { palette, client } = useApp();
  const router = useRouter();

  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [correspondentId, setCorrespondentId] = useState<number | null>(null);
  const [tagId, setTagId] = useState<number | null>(null);
  const [vocabulary, setVocabulary] = useState<ArchiveVocabulary | null>(null);
  const [documents, setDocuments] = useState<readonly ArchiveDocument[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'ok' | 'disabled' | 'error'>('ok');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (client === null) return;
    void client.archiveVocabulary().then((result) => {
      if (result.ok) setVocabulary(result.value);
    });
  }, [client]);

  const query = useMemo(
    () => ({
      ...(debounced === '' ? {} : { text: debounced }),
      ...(correspondentId === null ? {} : { correspondentId }),
      ...(tagId === null ? {} : { tagId }),
    }),
    [debounced, correspondentId, tagId],
  );

  // Every change to what is being asked for starts over at page one, rather than
  // appending results from a different search onto what is already on screen.
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    setLoading(true);
    void client.searchArchive({ ...query, page: 1 }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setStatus(
          result.reason.kind === 'server_error' && result.reason.status === 503
            ? 'disabled'
            : 'error',
        );
        setDocuments([]);
        setHasMore(false);
        return;
      }
      setStatus('ok');
      setDocuments(result.value.documents);
      setPage(result.value.page);
      setHasMore(result.value.hasMore);
    });
    return () => {
      cancelled = true;
    };
  }, [client, query]);

  const loadMore = useCallback(() => {
    if (client === null || loading || !hasMore) return;
    setLoading(true);
    void client.searchArchive({ ...query, page: page + 1 }).then((result) => {
      setLoading(false);
      if (!result.ok) return;
      setDocuments((prev) => [...prev, ...result.value.documents]);
      setPage(result.value.page);
      setHasMore(result.value.hasMore);
    });
  }, [client, loading, hasMore, page, query]);

  if (status === 'disabled') {
    return (
      <View style={[styles.centre, { backgroundColor: palette.background }]}>
        <EmptyState
          palette={palette}
          title="Your library isn't set up yet."
          body="Browsing needs your server to be forwarding to Paperless. Ask whoever runs it to set PAPERLESS_URL, or see the ingest server's README."
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Search your documents"
        placeholderTextColor={palette.textMuted}
        accessibilityLabel="Search your documents"
        style={[
          styles.search,
          { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
        ]}
      />

      {vocabulary === null ? null : (
        <>
          <Chips
            entries={vocabulary.correspondents}
            selectedIds={correspondentId === null ? [] : [correspondentId]}
            onToggle={(id) => setCorrespondentId(correspondentId === id ? null : id)}
            palette={palette}
            label="Filter by correspondent"
          />
          <Chips
            entries={vocabulary.tags}
            selectedIds={tagId === null ? [] : [tagId]}
            onToggle={(id) => setTagId(tagId === id ? null : id)}
            palette={palette}
            label="Filter by tag"
          />
        </>
      )}

      <FlatList
        data={documents}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={documents.length === 0 ? styles.emptyContainer : styles.list}
        onEndReachedThreshold={0.5}
        onEndReached={loadMore}
        ListEmptyComponent={
          status === 'error' ? (
            <EmptyState
              palette={palette}
              title="Couldn't reach your server."
              body="Pull to try again, or check your connection."
            />
          ) : !loading ? (
            <EmptyState
              palette={palette}
              title={debounced === '' ? 'Nothing here yet.' : 'No matches.'}
              body={
                debounced === ''
                  ? 'Documents your server has already indexed will show up here.'
                  : 'Try a different search or clear the filters above.'
              }
            />
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.title}
            onPress={() =>
              router.push({ pathname: '/archive/[id]', params: { id: String(item.id) } })
            }
            style={styles.row}
          >
            {client === null ? null : (
              <Image
                source={client.archiveThumbnailSource(item.id)}
                style={[styles.thumb, { backgroundColor: palette.surfaceRaised }]}
                resizeMode="cover"
                accessibilityIgnoresInvertColors
              />
            )}
            <View style={styles.rowMain}>
              <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={[styles.meta, { color: palette.textMuted }]} numberOfLines={1}>
                {[item.correspondent, item.documentType].filter((v) => v !== null).join(' · ') ||
                  item.created}
              </Text>
              {item.contentSnippet === null ? null : (
                <Text style={[styles.snippet, { color: palette.textMuted }]} numberOfLines={2}>
                  {item.contentSnippet}
                </Text>
              )}
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  search: {
    margin: spacing.md,
    marginBottom: spacing.sm,
    minHeight: TOUCH_TARGET,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  list: { paddingVertical: spacing.sm },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: TOUCH_TARGET + spacing.lg,
  },
  thumb: { width: 52, height: 68, borderRadius: 4 },
  rowMain: { flex: 1, gap: spacing.xs },
  title: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 13 },
  snippet: { fontSize: 13, lineHeight: 18 },
});
