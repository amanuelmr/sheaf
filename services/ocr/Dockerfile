# The OCR sidecar: the official OCRmyPDF image plus a forty-line HTTP wrapper.
# Pinned, for the same reason as Paperless: a new release changes what OCR produces,
# so moving it is a choice rather than an accident.
FROM jbarlow83/ocrmypdf-alpine:v17.13.0

WORKDIR /srv
COPY services/ocr/server.py /srv/server.py

# The base image already runs as an unprivileged user (uid 1000), which is all this
# needs: it reads a request, writes temporary files, and answers.

ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["python3", "/srv/server.py"]
