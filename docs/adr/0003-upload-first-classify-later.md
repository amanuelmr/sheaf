# 3. Upload first, classify later

- Status: accepted
- Date: 2026-08-23

## Context

Every mobile capture flow for Paperless — including the one originally specified for
this project — goes scan → review → save & sync. The review step is a human-blocking
barrier in a pipeline that has no technical need for one. It is also, on inspection,
the actual source of the friction the product exists to remove.

Separately: on-device OCR guessing correspondent, type, date and amount competes
with Paperless's own classifier, which is trained on the user's real corpus and
already exposed at `/api/documents/{id}/suggestions/`.

## Decision

Commit and upload at the shutter. Metadata is applied afterwards, by `PATCH` on a
document that is already stored, from Paperless's own suggestions.

On-device OCR is rescoped to the two things the server cannot do for us: searching
your own outbox while offline, and catching near-duplicates (the same receipt shot
twice at slightly different angles).

## Consequences

Good:

- The document reaches the server in seconds, and nothing is ever blocked on a
  human.
- Batch capture becomes the default rather than a later feature: shutter through a
  stack, triage afterwards.
- Suggestion quality comes from the user's own corpus instead of regex over mobile
  OCR.
- OCR failure cannot affect delivery, because delivery does not depend on OCR.

Costs:

- Documents can briefly exist in Paperless with no metadata, which users who watch
  their inbox will notice.
- Metadata delivery becomes a second syncable intent with its own failure mode, not
  part of the upload.
- Suggestions require a round trip, so classification is unavailable offline.
- It diverges from what Paperless users expect from other capture apps, which needs
  explaining in the UI.
