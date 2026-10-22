#!/usr/bin/env python3
"""Two bounded, fixed-response host listeners for egress qualification.

Never reads or serves files from the invocation directory. Ports are allocated
by the listening sockets themselves, then published atomically for the caller.
"""

import argparse
import signal
import threading
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


class ProbeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"egress-probe\n" if self.path == "/probe" else b"not found\n"
        self.send_response(200 if self.path == "/probe" else 404)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class ProbeServer(HTTPServer):
    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(2)
        return connection, address


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--ports-file", type=Path, required=True)
    args = parser.parse_args()
    with ExitStack() as stack:
        servers = [
            stack.enter_context(ProbeServer((args.bind, 0), ProbeHandler))
            for _ in range(2)
        ]
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        temporary = args.ports_file.with_suffix(".tmp")
        temporary.write_text(" ".join(str(s.server_port) for s in servers) + "\n")
        temporary.replace(args.ports_file)
        signal.pause()


if __name__ == "__main__":
    main()
