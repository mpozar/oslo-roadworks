"""
Proxy server for Oslo Roadworks.
Forwards /api/map/* requests to pub.soksys.no (bypassing CORS) and serves static files.

Usage:
    python3 proxy.py
    open http://localhost:8765
"""

import os
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPSTREAM  = "https://pub.soksys.no"
PORT      = 8765

MIME = {
    ".html": "text/html",
    ".css":  "text/css",
    ".js":   "application/javascript",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if self.path.startswith("/api/map/"):
            self._proxy()
        elif path in ("/", "/index.html"):
            self._serve_file("index.html", "text/html")
        elif path in ("/style.css", "/app.js"):
            ext = os.path.splitext(path)[1]
            self._serve_file(path.lstrip("/"), MIME.get(ext, "text/plain"))
        else:
            self.send_error(404)

    def _proxy(self):
        url = UPSTREAM + self.path
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "oslo-roadworks-proxy/0.1"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(f'{{"error": "{e}"}}'.encode())

    def _serve_file(self, filename, content_type):
        try:
            with open(os.path.join(BASE_DIR, filename), "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_error(404)

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} - {fmt % args}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Oslo Roadworks running at http://localhost:{PORT}")
    print("Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
