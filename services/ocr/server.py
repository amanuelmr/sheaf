"""The OCR sidecar: POST a PDF to /ocr, get back the text OCRmyPDF finds in it.

Only the Sheaf server talks to this, over a private network, so it has no auth of
its own and no port published to the host. It handles one document at a time on
purpose: OCR is CPU-bound, and the job runner already sends one request at a time.

Document text is never logged.
"""

import json
import os
import socketserver
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

# Every interface inside its container, where only the compose network can reach it.
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
LANGUAGES = os.environ.get("OCR_LANGUAGES", "eng")
MAX_BYTES = 25 * 1024 * 1024  # the same bound as the Sheaf protocol's documents
TIMEOUT_SECONDS = int(os.environ.get("OCR_TIMEOUT_SECONDS", "300"))

# OCRmyPDF exit codes that mean "this PDF cannot be read", which retrying cannot fix.
UNREADABLE = {2: "not a valid PDF", 8: "the PDF is encrypted"}


def engine_version() -> str:
    try:
        out = subprocess.run(
            ["ocrmypdf", "--version"], capture_output=True, text=True, timeout=30, check=True
        )
        return "ocrmypdf-" + out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return "ocrmypdf"


ENGINE = engine_version()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self.reply(200, {"engine": ENGINE, "languages": LANGUAGES})
        else:
            self.reply(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/ocr":
            self.reply(404, {"error": "not_found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self.reply(400, {"error": "empty body"})
            return
        if length > MAX_BYTES:
            self.reply(413, {"error": "too_large"})
            return
        body = self.rfile.read(length)

        with tempfile.TemporaryDirectory() as work:
            source = os.path.join(work, "in.pdf")
            target = os.path.join(work, "out.pdf")
            sidecar = os.path.join(work, "text.txt")
            with open(source, "wb") as handle:
                handle.write(body)
            try:
                result = subprocess.run(
                    [
                        "ocrmypdf",
                        "--skip-text",  # pages that already have text keep it
                        "--sidecar", sidecar,
                        "--language", LANGUAGES,
                        "--jobs", "1",
                        "--output-type", "pdf",
                        "--quiet",
                        source,
                        target,
                    ],
                    capture_output=True,
                    timeout=TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                self.reply(504, {"error": "timed out"})
                return

            if result.returncode in UNREADABLE:
                self.reply(422, {"error": UNREADABLE[result.returncode]})
                return
            if result.returncode != 0:
                self.reply(500, {"error": f"ocrmypdf exited {result.returncode}"})
                return
            text = ""
            if os.path.exists(sidecar):
                with open(sidecar, encoding="utf-8", errors="replace") as handle:
                    # OCRmyPDF writes a marker line for each page it skipped for
                    # already having text; the marker is not the page's text.
                    text = "\n".join(
                        line
                        for line in handle.read().splitlines()
                        if not line.startswith("[OCR skipped on page")
                    ).strip()
            self.reply(200, {"text": text, "engine": ENGINE})

    def reply(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:
        # Method, path and status only: never a document's contents.
        print(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)


class QuickHTTPServer(HTTPServer):
    """HTTPServer without the reverse-DNS lookup it does on bind.

    The standard one resolves its own address to a host name it never uses, and
    where DNS is slow or absent that single lookup was measured at 35 seconds.
    """

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port


if __name__ == "__main__":
    server = QuickHTTPServer((HOST, PORT), Handler)
    # Printed once the socket is bound, so "listening" in the log is true.
    print(f"ocr sidecar listening on {HOST}:{PORT}, {ENGINE}, languages {LANGUAGES}", flush=True)
    server.serve_forever()
