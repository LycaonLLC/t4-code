#!/usr/bin/env python3
"""Small, fail-closed Hermes notifier for the T4 maintainer.

The wrapper owns delivery. This helper only signs the exact bytes supplied by
its caller and posts them to the loopback Hermes route.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class _NoRedirectHandler(HTTPRedirectHandler):
    def http_error_301(self, request, response, code, message, headers):
        raise HTTPError(request.full_url, code, message, headers, None)

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301

MAX_PAYLOAD_BYTES = 16 * 1024
MAX_SECRET_BYTES = 4 * 1024
MAX_TIMEOUT_SECONDS = 5.0
DEFAULT_URL = "http://127.0.0.1:8644/webhooks/t4-maintainer"
DEFAULT_ROUTE = "t4-maintainer"


def _fail(message: str) -> None:
    raise ValueError(message)


def validate_route(route: str) -> str:
    if not isinstance(route, str) or not route or len(route) > 64:
        _fail("notification route is invalid")
    if not all(char.isalnum() or char in "._-" for char in route) or not route[0].isalnum():
        _fail("notification route is invalid")
    return route


def validate_url(url: str, route: str = DEFAULT_ROUTE) -> str:
    route = validate_route(route)
    if not isinstance(url, str) or len(url) > 256:
        _fail("notification URL is invalid")
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
        _fail("notification URL must use loopback HTTP")
    if parsed.username is not None or parsed.password is not None:
        _fail("notification URL must not contain credentials")
    if parsed.port != 8644:
        _fail("notification URL must use the Hermes loopback port")
    if parsed.query or parsed.fragment:
        _fail("notification URL must not contain query or fragment")
    if parsed.path != f"/webhooks/{route}":
        _fail("notification URL route is invalid")
    return url

def read_secret(secret_file: str) -> bytes:
    path = Path(secret_file)
    try:
        info = path.lstat()
    except OSError as exc:
        raise ValueError("notification secret is unavailable") from exc
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
        _fail("notification secret must be an owner-only regular file")
    try:
        value = path.read_bytes()
    except OSError as exc:
        raise ValueError("notification secret is unavailable") from exc
    if not value or len(value) > MAX_SECRET_BYTES or b"\x00" in value:
        _fail("notification secret has an invalid size")
    return value.rstrip(b"\r\n") or _fail("notification secret is empty")


def sign_payload(payload: bytes, secret: bytes) -> str:
    if not isinstance(payload, bytes) or len(payload) == 0 or len(payload) > MAX_PAYLOAD_BYTES:
        _fail("notification payload is too large or empty")
    if not isinstance(secret, bytes) or not secret:
        _fail("notification secret is empty")
    return "sha256=" + hmac.new(secret, payload, hashlib.sha256).hexdigest()


def post_notification(*, url: str, route: str, secret_file: str, payload: bytes, timeout: float = 3.0) -> None:
    route = validate_route(route)
    validate_url(url, route)
    if timeout <= 0 or timeout > MAX_TIMEOUT_SECONDS:
        _fail("notification timeout is outside the bounded limit")
    signature = sign_payload(payload, read_secret(secret_file))
    request = Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(payload)),
            "X-GitHub-Event": "t4-maintainer",
            "X-Hub-Signature-256": signature,
        },
    )
    try:
        with build_opener(_NoRedirectHandler()).open(request, timeout=timeout) as response:
            status = int(response.status)
            response.read(1024)
            if status < 200 or status >= 300:
                _fail("notification endpoint rejected the event")
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise ValueError("notification delivery failed") from exc
def _arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("T4_MAINTAINER_HERMES_URL", DEFAULT_URL))
    parser.add_argument("--route", default=os.environ.get("T4_MAINTAINER_HERMES_ROUTE", DEFAULT_ROUTE))
    parser.add_argument("--secret-file", default=os.environ.get("T4_MAINTAINER_HERMES_SECRET_FILE", ""))
    parser.add_argument("--payload-file")
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("T4_MAINTAINER_HERMES_TIMEOUT", "3")))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = _arguments(argv if argv is not None else sys.argv[1:])
        if not args.secret_file:
            _fail("notification secret file is not configured")
        if args.payload_file:
            payload = Path(args.payload_file).read_bytes()
        else:
            payload = sys.stdin.buffer.read(MAX_PAYLOAD_BYTES + 1)
        if len(payload) > MAX_PAYLOAD_BYTES:
            _fail("notification payload is too large")
        try:
            document = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("notification payload must be valid UTF-8 JSON") from exc
        if not isinstance(document, dict):
            _fail("notification payload must be a JSON object")
        post_notification(url=args.url, route=args.route, secret_file=args.secret_file, payload=payload, timeout=args.timeout)
        return 0
    except (OSError, ValueError) as exc:
        print(f"notification warning: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
