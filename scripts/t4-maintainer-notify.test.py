#!/usr/bin/env python3
import importlib.util
import os
import stat
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("t4_notify", Path(__file__).parents[1] / "ops/t4-maintainer/notify.py")
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)


class Response:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return b"ok"


class Opener:
    def __init__(self, status):
        self.status = status
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        return Response(self.status)


def main():
    with tempfile.TemporaryDirectory() as directory:
        secret = Path(directory) / "secret"
        secret.write_bytes(b"test-secret\n")
        os.chmod(secret, stat.S_IRUSR | stat.S_IWUSR)
        opener = Opener(204)
        notify.build_opener = lambda *_args: opener
        notify.post_notification(
            url=notify.DEFAULT_URL,
            route=notify.DEFAULT_ROUTE,
            secret_file=str(secret),
            payload=b'{"event":"test"}',
        )
        assert len(opener.calls) == 1
        request, timeout = opener.calls[0]
        assert request.method == "POST"
        assert request.headers["X-github-event"] == "t4-maintainer"
        assert timeout == 3.0

        opener.status = 500
        try:
            notify.post_notification(
                url=notify.DEFAULT_URL,
                route=notify.DEFAULT_ROUTE,
                secret_file=str(secret),
                payload=b'{"event":"test"}',
            )
        except ValueError as error:
            assert str(error) == "notification endpoint rejected the event"
        else:
            raise AssertionError("failed delivery must fail closed")

        missing = Path(directory) / "missing"
        try:
            notify.post_notification(
                url=notify.DEFAULT_URL,
                route=notify.DEFAULT_ROUTE,
                secret_file=str(missing),
                payload=b'{"event":"test"}',
            )
        except ValueError as error:
            assert str(error) == "notification secret is unavailable"
        else:
            raise AssertionError("missing secret must fail closed")
        assert len(opener.calls) == 2, "missing secret must not invoke opener"


if __name__ == "__main__":
    main()
