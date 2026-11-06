#!/usr/bin/env python3
"""Two bounded, fixed-response host listeners for egress qualification.

Never reads or serves files from the invocation directory. Ports are allocated
by the listening sockets themselves, then published atomically for the caller.
"""

import argparse
import signal
import socketserver
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
    def server_bind(self):
        # HTTPServer.server_bind names the server with socket.getfqdn, a
        # reverse-DNS query that blocks for as long as the resolver takes,
        # even for 127.0.0.1, before any port is published. A slow resolver
        # turned that into a missing ports file. The fixed-response handler
        # never reads server_name, so record the bind address instead.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

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
