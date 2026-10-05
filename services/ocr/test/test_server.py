"""Tests for the OCR sidecar, against a fake ocrmypdf.

    python3 -m unittest discover services/ocr/test
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

# Put a fake `ocrmypdf` first on PATH before the server module asks it its version.
_bin = tempfile.mkdtemp()
shutil.copy(os.path.join(HERE, "fake-ocrmypdf"), os.path.join(_bin, "ocrmypdf"))
os.chmod(os.path.join(_bin, "ocrmypdf"), 0o755)
os.environ["PATH"] = _bin + os.pathsep + os.environ["PATH"]
sys.path.insert(0, os.path.dirname(HERE))

import server  # noqa: E402


class SidecarTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = server.QuickHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def request(self, method: str, path: str, body: bytes | None = None) -> tuple[int, dict]:
        req = urllib.request.Request(self.base + path, data=body, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_reports_its_engine(self) -> None:
        status, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["engine"], "ocrmypdf-17.13.0")

    def test_returns_the_text_without_skipped_page_markers(self) -> None:
        status, body = self.request("POST", "/ocr", b"%PDF-1.4 a scanned page")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"text": "INVOICE total 99.00", "engine": "ocrmypdf-17.13.0"})

    def test_refuses_a_pdf_it_cannot_read_as_unprocessable(self) -> None:
        status, body = self.request("POST", "/ocr", b"ENCRYPTED")
        self.assertEqual(status, 422)
        self.assertIn("encrypted", body["error"])

    def test_refuses_an_empty_body(self) -> None:
        status, _ = self.request("POST", "/ocr", b"")
        self.assertEqual(status, 400)

    def test_answers_not_found_elsewhere(self) -> None:
        self.assertEqual(self.request("GET", "/ocr")[0], 404)
        self.assertEqual(self.request("POST", "/other", b"x")[0], 404)


if __name__ == "__main__":
    unittest.main()
