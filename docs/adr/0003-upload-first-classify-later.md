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

## Amendment: straightening a page is not reviewing it

Removing the review screen was read, in practice, as removing _all_ post-capture
steps — so the app shipped with no crop and no rotate, and `expo-image-manipulator`
sat in `package.json` unused. The result was that a real scan of a cinema receipt
produced 56 characters of OCR noise. "Photograph a document and it is searchable"
was not true, which made the speed worthless: the app was fast at producing
documents nobody could find.

Measured on that receipt, forwarded to a real Paperless-ngx:

|                                       | OCR characters                 |
| ------------------------------------- | ------------------------------ |
| raw photo, as shipped                 | 56 (noise)                     |
| turned upright and trimmed            | **257** (dates, names, totals) |
| plus a hand-rolled adaptive threshold | 209                            |

So a page editor is back — but only rotate and crop, and nothing that asks a
question. That distinction is the point: this ADR is about not making someone fill
in a form before their document is safe, and it stands. Deciding which way up a
page goes is part of scanning, not filing.

The third row is why there is no enhancement filter. Thresholding a crumpled
receipt destroyed as many strokes as it sharpened. It reads as an obvious
improvement and measured as a regression, so it was not built.

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
