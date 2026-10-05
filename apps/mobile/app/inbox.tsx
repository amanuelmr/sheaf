import { useMemo, useState } from 'react';
import { FlatList, Image, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import type { MetadataPatch } from '@sheaf/core';
import { awaitingReview, type OutboxRow } from '@sheaf/store';
import { useApp } from '../src/runtime/app-context';
import { shortId } from '../src/lib/format';
import { spacing, TOUCH_TARGET } from '../src/theme';
import { Button, Divider, EmptyState } from '../src/ui/components';

/**
 * The inbox: documents the server has read, waiting for a person to agree.
 *
 * This is the "classify later" half of ADR 0003. Nothing here stands between a page
 * and the server: every document in this list is already safely stored. Accepting
 * files the suggested details as they are; editing opens them, filled in, to change.
 */
export default function Inbox() {
  const { palette, outbox, accept } = useApp();
  const router = useRouter();
  const rows = useMemo(() => awaitingReview(outbox), [outbox]);
  // Rows accepted this visit, hidden at once rather than after the log catches up.
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const visible = rows.filter((row) => !accepted.has(row.docId));

  const acceptRow = async (row: OutboxRow) => {
    setAccepted((previous) => new Set(previous).add(row.docId));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await accept(row.docId, patchFrom(row));
  };

  return (
    <FlatList
      style={{ backgroundColor: palette.background }}
      data={visible}
      keyExtractor={(row) => row.docId}
      contentContainerStyle={visible.length === 0 ? styles.emptyContainer : styles.list}
      ItemSeparatorComponent={() => <Divider palette={palette} />}
      ListEmptyComponent={
        <EmptyState
          palette={palette}
          title="Nothing to review."
          body="When your server has read a document you scanned, its suggested details wait here for you to accept or change."
        />
      }
      renderItem={({ item }) => {
        const review = item.review ?? {};
        const details = [review.correspondent, review.documentType, review.date].filter(Boolean);
        return (
          <View style={styles.row} testID="inbox-row">
            {item.thumbnailPath === null ? (
              <View style={[styles.thumb, { backgroundColor: palette.surfaceRaised }]} />
            ) : (
              <Image
                source={{ uri: item.thumbnailPath }}
                style={[styles.thumb, { backgroundColor: palette.surfaceRaised }]}
                resizeMode="cover"
                accessibilityIgnoresInvertColors
              />
            )}
            <View style={styles.main}>
              <Text style={[styles.title, { color: palette.text }]} numberOfLines={2}>
                {review.title ?? `Scan ${shortId(item.docId)}`}
              </Text>
              {details.length === 0 ? null : (
                <Text style={[styles.meta, { color: palette.textMuted }]} numberOfLines={1}>
                  {details.join(' · ')}
                </Text>
              )}
              {review.tags === undefined || review.tags.length === 0 ? null : (
                <Text style={[styles.meta, { color: palette.textMuted }]} numberOfLines={1}>
                  {review.tags.join(', ')}
                </Text>
              )}
              <View style={styles.actions}>
                <Button
                  label="Accept"
                  palette={palette}
                  onPress={() => void acceptRow(item)}
                  style={styles.action}
                />
                <Button
                  label="Edit"
                  variant="secondary"
                  palette={palette}
                  onPress={() =>
                    router.push({ pathname: '/document/[id]', params: { id: item.docId } })
                  }
                  style={styles.action}
                />
              </View>
            </View>
          </View>
        );
      }}
    />
  );
}

/**
 * The suggestions as details to file, leaving out anything not suggested. The date is
 * shown but not sent: protocol v1 has no field for a document's date yet, and sending
 * it would only look as if it were saved.
 */
function patchFrom(row: OutboxRow): MetadataPatch {
  const review = row.review ?? {};
  return {
    ...(review.title === undefined ? {} : { title: review.title }),
    ...(review.correspondent === undefined ? {} : { correspondent: review.correspondent }),
    ...(review.documentType === undefined ? {} : { documentType: review.documentType }),
    ...(review.tags === undefined ? {} : { tags: review.tags }),
  };
}

const styles = StyleSheet.create({
  list: { paddingVertical: spacing.sm },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  thumb: { width: 52, height: 68, borderRadius: 4 },
  main: { flex: 1, gap: spacing.xs },
  title: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 13 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  action: { flex: 1, minHeight: TOUCH_TARGET },
});
