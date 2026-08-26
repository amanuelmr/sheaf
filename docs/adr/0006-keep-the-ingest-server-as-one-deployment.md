# 6. Keep the ingest server, but stop it being a second thing to run

- Status: accepted
- Date: 2026-08-25

## Context

The original spec was explicit: no backend (§58). We built one anyway, then added a
forwarder to Paperless — so a user was being asked to host two servers where the
spec had one. The main justification at the time was that Paperless could not be
trusted to answer "do you already hold this document", and that turned out to be
**wrong**: tested against a real server, `original_filename__istartswith` filters
correctly.

So the stated reason for the extra hop evaporated, and the question deserved
re-opening rather than surviving by inertia.

## What actually happened when we tested against a real server

Three incompatibilities surfaced in one afternoon, none of which any amount of unit
testing had caught:

- Paperless reports task status in lowercase (`success`), not uppercase. Comparing
  exactly meant reading every successful upload as a refusal.
- It does **not** reject a re-sent document. The same bytes produced a second
  document, which is the opposite of what ADR 0002 assumed.
- It _filters_ on `original_filename__istartswith` but _returns_ the value as
  `original_file_name`. The parameter and the field are spelled differently.

That is the real argument, and it is not the one we started with. Every one of
those was fixed by editing a server and running `docker compose up`. Had the phone
been talking to Paperless directly, all three would have been bugs in a shipped
app, fixable only by an App Store release that every user then had to install.

The phone is the most expensive place to be wrong, and Paperless is a moving
target across versions. Putting a layer we control in between means version
compatibility is a deployment concern rather than a release concern.

## Decision

Keep the ingest server, and remove the thing that made it feel like a burden.

One compose file brings up everything with `docker compose up -d`. `ingest` is the
door the phone knocks on; `paperless` is what makes a stored document findable.
Two containers, one deployment.

The server also mints its own Paperless token from the admin credentials, retrying
until Paperless has finished booting. Requiring someone to wait several minutes,
fetch a token by hand and restart is exactly the kind of setup step that decides
whether a thing gets used.

## Consequences

Good:

- Version quirks in a system we do not control are absorbed where they can be
  fixed by a pull, not a release.
- A capture finishes after one short upload to a machine on mains power. All the
  retrying happens between two servers, where nobody is waiting.
- Content-addressed `PUT` gives real idempotency and catches corruption at the
  door, neither of which the Paperless API can offer.
- `docker compose up ingest` still runs the door alone, for someone who wants
  storage without search.

Costs, stated plainly:

- It is still more moving parts than the spec asked for, and the spec was not
  wrong to be suspicious of that.
- Documents make two hops, so there is a window where a document is safe with us
  and not yet searchable. The forwarding state is exposed in the API and on the
  document screen rather than hidden.
- The admin-credential token path is a convenience that trades a little security
  for setup that actually completes. `PAPERLESS_TOKEN` overrides it for anyone who
  would rather issue a scoped token by hand.
