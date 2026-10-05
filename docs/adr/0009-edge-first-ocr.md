# 9. Edge-first OCR, with a server fallback

- Status: accepted
- Date: 2026-10-05 (accepted on implementation in steps 2.1–2.6)

## Context

Under ADR 0007 the server must make documents searchable itself. The phone already
runs Apple Vision / Google ML Kit on every captured page (`packages/outbox-ocr`,
via `expo-ocr-kit`) and then throws the text away once the document is released.
Server OCR (OCRmyPDF + Tesseract, as Paperless uses) is proven but costs CPU on a
home server, and heavier engines (Docling, olmOCR) want GPUs and 1–2 GB of weights.

## Decision

- After a document's `PUT` succeeds, the engine sends its on-device text with
  `PUT /v1/documents/{sha}/text` (source `edge`, engine and version recorded). This is
  bounded post-sync work under invariant 4: backoff, budget, terminal state. It can
  never block or undo delivery.
- The server indexes edge text immediately.
- A document with no text after a grace period (or from a client that has none: the
  web, email) gets an OCR job against an **`ocrmypdf` sidecar container**, so the
  Sheaf server keeps no runtime dependencies.
- Text is stored per source; if both exist, search indexes both, and display prefers
  the server's layout-aware text.

## Consequences

Most documents become searchable with no server compute, seconds after upload. The
privacy story is unchanged (text goes where the PDF already went). The cost is an
extra request per document and a second container for the fallback. Docling or a
VLM can later be added as another `TextRecognizer` adapter without changing this.
