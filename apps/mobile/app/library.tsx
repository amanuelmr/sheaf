import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ArchiveVocabulary } from '@sheaf/protocol';
import { searchCache } from '../src/adapters/archive-cache';
import { useApp } from '../src/runtime/app-context';
import { Chips, EmptyState } from '../src/ui/components';
import { spacing, radius, TOUCH_TARGET } from '../src/theme';

const DEBOUNCE_MS = 300;

/** What one row needs, whichever of the two sources below it came from. */
interface Row {
  readonly id: number;
  readonly title: string;
  readonly correspondent: string | null;
  readonly documentType: string | null;
  readonly created: string;
  readonly contentSnippet: string | null;
  readonly thumbnail: { readonly uri: string; readonly headers?: Record<string, string> } | null;
}

/**
 * Everything your server already holds, not just what this phone captured —
 * fetched live from Paperless every time it can be, never cached beyond what was
 * actually opened. See `ArchiveDocument` in `@sheaf/protocol` for why: a second,
 * possibly-stale copy of your whole archive is exactly the duplication the rest
 * of this protocol avoids. Offline, this falls back to exactly that smaller,
 * deliberate cache -- see `@sheaf/archive-cache`.
 */
export default function Library() {
  const { palette, client, driver, offline } = useApp();
  const router = useRouter();

  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [correspondentId, setCorrespondentId] = useState<number | null>(null);
  const [tagId, setTagId] = useState<number | null>(null);
  const [vocabulary, setVocabulary] = useState<ArchiveVocabulary | null>(null);
  const [documents, setDocuments] = useState<readonly Row[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'ok' | 'disabled' | 'error'>('ok');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (client === null || offline) return;
    void client.archiveVocabulary().then((result) => {
      if (result.ok) setVocabulary(result.value);
    });
  }, [client, offline]);

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
    if (offline) {
      if (driver === null) return;
      let cancelled = false;
      void searchCache(driver, debounced).then((cached) => {
        if (cancelled) return;
        setStatus('ok');
        setDocuments(
          cached.map((item) => ({
            id: item.id,
            title: item.title,
            correspondent: item.correspondent,
            documentType: item.documentType,
            created: item.created,
            contentSnippet: item.contentSnippet,
            thumbnail: item.thumbnailPath === null ? null : { uri: item.thumbnailPath },
          })),
        );
        setHasMore(false);
      });
      return () => {
        cancelled = true;
      };
    }

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
      setDocuments(
        result.value.documents.map((item) => ({
          id: item.id,
          title: item.title,
          correspondent: item.correspondent,
          documentType: item.documentType,
          created: item.created,
          contentSnippet: item.contentSnippet,
          thumbnail: client.archiveThumbnailSource(item.id),
        })),
      );
      setPage(result.value.page);
      setHasMore(result.value.hasMore);
    });
    return () => {
      cancelled = true;
    };
  }, [client, driver, offline, query, debounced]);

  const loadMore = useCallback(() => {
    if (offline || client === null || loading || !hasMore) return;
    setLoading(true);
    void client.searchArchive({ ...query, page: page + 1 }).then((result) => {
      setLoading(false);
      if (!result.ok) return;
      setDocuments((prev) => [
        ...prev,
        ...result.value.documents.map((item) => ({
          id: item.id,
          title: item.title,
          correspondent: item.correspondent,
          documentType: item.documentType,
          created: item.created,
          contentSnippet: item.contentSnippet,
          thumbnail: client.archiveThumbnailSource(item.id),
        })),
      ]);
      setPage(result.value.page);
      setHasMore(result.value.hasMore);
    });
  }, [offline, client, loading, hasMore, page, query]);

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
      {offline ? (
        <Text style={[styles.offlineNotice, { color: palette.waiting }]}>
          Offline — showing what you have opened or starred before.
        </Text>
      ) : null}

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
                offline
                  ? "You haven't opened or starred anything offline yet."
                  : debounced === ''
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
            {item.thumbnail === null ? null : (
              <Image
                source={item.thumbnail}
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
  offlineNotice: { fontSize: 13, paddingHorizontal: spacing.md, paddingTop: spacing.md },
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
