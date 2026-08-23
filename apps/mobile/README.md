# apps/mobile

Not started yet — deliberately.

The sync engine is being built and proven first, because it is the part where being
wrong is expensive and the part that no UI work can rescue. See
[ADR 0001](../../docs/adr/0001-append-only-intent-log.md) and
[ADR 0002](../../docs/adr/0002-exactly-once-via-content-addressing.md).

When it starts, this becomes an Expo + Expo Router app whose job is narrow: run
effects, and render projections of the log.

```bash
pnpm create expo-app apps/mobile --template tabs
```

Planned shape:

```
app/            expo-router routes: camera at the root, outbox and inbox as sheets
  index.tsx     the shutter — the app opens here, nothing in front of it
components/     design-system primitives and document views
executor/       the impure half of the loop: takes commands from @sheaf/core,
                performs I/O, appends the resulting events back to the log
db/             SQLite: the append-only event log and its projections
```

The executor is the only place allowed to read a clock, generate randomness, touch
the filesystem, or make a request. Everything it does is a `Command` handed to it by
`next()` in `@sheaf/core`, and everything it learns comes back as an event.
