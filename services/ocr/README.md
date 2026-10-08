# OCR sidecar

Reads a PDF with [OCRmyPDF](https://ocrmypdf.readthedocs.io) (Tesseract underneath)
and answers with its text. It is the server-side fallback of
[ADR 0009](../../docs/adr/0009-edge-first-ocr.md): the phone normally recognises text
itself and sends it, so this only reads documents that arrive with no text from
anywhere, after a grace period.

```
POST /ocr     body: a PDF    →  200 {"text": "...", "engine": "ocrmypdf-17.13.0"}
                                 422 unreadable (not a PDF, or encrypted)
                                 413 over 25 MB · 504 took too long
GET  /health                 →  200 {"engine": "...", "languages": "eng"}
```

It has no authentication and publishes no port: only the Sheaf server reaches it,
over the compose network. It never logs document text.

## Running it

```bash
docker compose -f compose.yml -f compose.ocr.yml up -d
```

`OCR_LANGUAGES` takes Tesseract language codes joined with `+` (for example
`eng+deu`); the image ships English, and other languages need their Tesseract data
added to the image.

## Tests

```bash
python3 -m unittest discover services/ocr/test
```

They run the real server against a stand-in `ocrmypdf` (`test/fake-ocrmypdf`), so no
Docker or Tesseract is needed. One finding from writing them: Python's `HTTPServer`
does a reverse-DNS lookup of its own address on bind, which took 35 seconds where DNS
was slow. `QuickHTTPServer` skips it.
