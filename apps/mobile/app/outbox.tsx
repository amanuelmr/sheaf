import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import type { OutboxRow } from '@sheaf/store';
import { search as searchOutboxText } from '@sheaf/outbox-ocr';
import { useApp } from '../src/runtime/app-context';
import { formatBytes, pageLabel, retryIn, shortId, timeAgo } from '../src/lib/format';
import { radius, spacing, TOUCH_TARGET } from '../src/theme';
import { Button, Divider, EmptyState, StatusBadge } from '../src/ui/components';

const DEBOUNCE_MS = 300;

const tone = (row: OutboxRow): 'ok' | 'waiting' | 'danger' | 'neutral' => {
  if (row.status === 'SYNCED') return 'ok';
  if (row.status === 'FAILED' || row.status === 'BLOCKED') return 'danger';
  if (row.status === 'DRAFT') return 'neutral';
  return 'waiting';
};

/**
 * Every document, and an honest account of where it is. No row is ever left
 * ambiguous: each carries a symbol, a sentence, and — when something went wrong —
 * the reassurance that the document is still here.
 */
export default function Outbox() {
  const { palette, outbox, retry, refresh, driver } = useApp();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  // Doc ids whose *recognised text* (not title or status) matched, from the
  // on-device OCR of whatever this phone captured but hasn't synced yet. Null
  // means "no OCR search has run" -- distinct from an empty set, which means it
  // ran and found nothing.
  const [ocrMatches, setOcrMatches] = useState<ReadonlySet<string> | null>(null);
  const now = Date.now();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (driver === null || debounced.trim() === '') {
      setOcrMatches(null);
      return;
    }
    let cancelled = false;
    void searchOutboxText(driver, debounced).then((ids) => {
      if (!cancelled) setOcrMatches(new Set(ids));
    });
    return () => {
      cancelled = true;
    };
  }, [driver, debounced]);

  const filtered = useMemo(() => {
    const needle = debounced.trim().toLowerCase();
    if (needle === '') return outbox;
    return outbox.filter(
      (row) => row.title?.toLowerCase().includes(needle) === true || ocrMatches?.has(row.docId),
    );
  }, [outbox, debounced, ocrMatches]);

  const searching = debounced.trim() !== '';

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      {outbox.length === 0 ? null : (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search what you’ve scanned"
          placeholderTextColor={palette.textMuted}
          accessibilityLabel="Search what you’ve scanned"
          style={[
            styles.search,
            { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
          ]}
        />
      )}
      <FlatList
        data={filtered}
        keyExtractor={(row) => row.docId}
        contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={palette.accent}
          />
        }
        ItemSeparatorComponent={() => <Divider palette={palette} />}
        ListEmptyComponent={
          searching ? (
            <EmptyState
              palette={palette}
              title="No matches."
              body="Nothing waiting to sync has that title or recognised text. Recognition can take a moment after scanning."
            />
          ) : (
            <EmptyState
              palette={palette}
              title="You’re all caught up."
              body="Documents you scan appear here while they make their way to your server."
              action={
                <Button
                  label="Scan a document"
                  palette={palette}
                  onPress={() => router.replace('/')}
                />
              }
            />
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.label}. ${pageLabel(item.pageCount)}. Captured ${timeAgo(item.createdAt, now)}.`}
            onPress={() => router.push({ pathname: '/document/[id]', params: { id: item.docId } })}
            style={styles.row}
          >
            {item.thumbnailPath === null ? (
              <View style={[styles.thumbFallback, { backgroundColor: palette.surfaceRaised }]}>
                <Text style={[styles.thumbGlyph, { color: palette.textMuted }]}>{item.symbol}</Text>
              </View>
            ) : (
              <Image
                source={{ uri: item.thumbnailPath }}
                style={[styles.thumb, { backgroundColor: palette.surfaceRaised }]}
                resizeMode="cover"
                accessibilityIgnoresInvertColors
              />
            )}
            <View style={styles.rowMain}>
              <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
                {item.title ?? `Scan ${shortId(item.docId)}`}
              </Text>
              <Text style={[styles.meta, { color: palette.textMuted }]}>
                {pageLabel(item.pageCount)} · {formatBytes(item.bytes)} ·{' '}
                {timeAgo(item.createdAt, now)}
              </Text>
              <StatusBadge
                symbol={item.symbol}
                label={item.label}
                tone={tone(item)}
                palette={palette}
              />
              {item.detail === null ? null : (
                <Text style={[styles.detail, { color: palette.textMuted }]}>{item.detail}</Text>
              )}
              {retryIn(item.nextAttemptAt, now) === null ? null : (
                <Text style={[styles.detail, { color: palette.textMuted }]}>
                  {retryIn(item.nextAttemptAt, now)}
                </Text>
              )}
            </View>
            {item.actionable ? (
              <Button
                label="Retry"
                variant="secondary"
                palette={palette}
                onPress={() => void retry(item.docId)}
                style={styles.retry}
              />
            ) : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
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
  rowMain: { flex: 1, gap: spacing.xs },
  thumb: { width: 52, height: 68, borderRadius: 4 },
  thumbFallback: {
    width: 52,
    height: 68,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbGlyph: { fontSize: 20 },
  title: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 13 },
  detail: { fontSize: 13, lineHeight: 18 },
  retry: { paddingHorizontal: spacing.md, minHeight: TOUCH_TARGET },
});
