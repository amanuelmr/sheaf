import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { OutboxRow } from '@sheaf/store';
import { useApp } from '../src/runtime/app-context';
import { formatBytes, pageLabel, retryIn, shortId, timeAgo } from '../src/lib/format';
import { spacing, TOUCH_TARGET } from '../src/theme';
import { Button, Divider, EmptyState, StatusBadge } from '../src/ui/components';

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
  const { palette, outbox, retry, refresh } = useApp();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const now = Date.now();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  return (
    <FlatList
      data={outbox}
      keyExtractor={(row) => row.docId}
      contentContainerStyle={outbox.length === 0 ? styles.emptyContainer : styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          tintColor={palette.accent}
        />
      }
      ItemSeparatorComponent={() => <Divider palette={palette} />}
      ListEmptyComponent={
        <EmptyState
          palette={palette}
          title="You’re all caught up."
          body="Documents you scan appear here while they make their way to Paperless."
          action={
            <Button label="Scan a document" palette={palette} onPress={() => router.replace('/')} />
          }
        />
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.label}. ${pageLabel(item.pageCount)}. Captured ${timeAgo(item.createdAt, now)}.`}
          onPress={() => router.push({ pathname: '/document/[id]', params: { id: item.docId } })}
          style={styles.row}
        >
          <View style={styles.rowMain}>
            <Text style={[styles.title, { color: palette.text }]}>
              {item.remoteId === null
                ? `Scan ${shortId(item.docId)}`
                : `Document #${item.remoteId}`}
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
  );
}

const styles = StyleSheet.create({
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
  title: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 13 },
  detail: { fontSize: 13, lineHeight: 18 },
  retry: { paddingHorizontal: spacing.md, minHeight: TOUCH_TARGET },
});
