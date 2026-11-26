import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class GameHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description="Serve Planetary Accord locally.")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    handler = partial(GameHandler, directory=directory)
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"Planetary Accord: http://localhost:{server.server_port}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
