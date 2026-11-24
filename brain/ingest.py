"""The ingest client: posts screened items to the brain-ingest Edge Function.

Slice 1 owns this file.

The token travels in `X-Brain-Ingest-Token`, never in `Authorization` (D12).
The cloud environment attaches network secrets *by host*, and the project host
also serves the REST API and Auth, which `brain review`, `digest` and `status`
call signed in as you with their own `Authorization` header. A token in that
header would either collide with yours or be sent on every call that touches
the host.

Two ways the token arrives, and the client must not confuse them:

- **Locally**, `BRAIN_INGEST_TOKEN` is set and this client puts it in the
  header itself.
- **In the cloud environment**, the token is a *network secret*: the proxy adds
  it on the way out and it never enters the session's machine at all. Then the
  variable is unset and the client sends no token header, which is correct —
  adding an empty one would overwrite what the proxy injects.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import httpx

from brain.contract import IngestResult, Watermark

TOKEN_HEADER = "X-Brain-Ingest-Token"
TOKEN_ENV = "BRAIN_INGEST_TOKEN"
URL_ENV = "SUPABASE_URL"
DEFAULT_TIMEOUT = 60.0
MAX_ITEMS_PER_BATCH = 500


class IngestError(RuntimeError):
    pass


class IngestClient:
    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get(URL_ENV, "")).rstrip("/")
        if not self.base_url:
            raise IngestError(f"{URL_ENV} is not set; see docs/cloud-setup.md")
        # Deliberately not falling back to a default: an empty token header
        # would overwrite one the proxy injects.
        self.token = token if token is not None else os.environ.get(TOKEN_ENV)
        self._timeout = timeout
        self._client = client

    @property
    def endpoint(self) -> str:
        return f"{self.base_url}/functions/v1/brain-ingest"

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers[TOKEN_HEADER] = self.token
        return headers

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        def send(client: httpx.Client) -> httpx.Response:
            return client.post(
                self.endpoint, json=payload, headers=self._headers(), timeout=self._timeout
            )

        response = send(self._client) if self._client else send(httpx.Client())

        if response.status_code == 401:
            raise IngestError(
                "brain-ingest refused the token. Locally, set BRAIN_INGEST_TOKEN; in the cloud "
                f"environment, add it as a network secret for this host and send it as {TOKEN_HEADER}."
            )
        if response.status_code == 413:
            raise IngestError("the batch was too large; split it and post again")
        if response.status_code >= 400:
            raise IngestError(f"brain-ingest returned {response.status_code}: {response.text[:400]}")
        return response.json()

    # -- the two things the token may do -------------------------------------

    def post_batch(
        self,
        items: Iterable[dict[str, Any]],
        watermarks: Iterable[Watermark] | None = None,
        *,
        dry: bool = False,
    ) -> IngestResult:
        items = list(items)
        if len(items) > MAX_ITEMS_PER_BATCH:
            raise IngestError(
                f"{len(items)} items in one batch; the contract caps it at {MAX_ITEMS_PER_BATCH}"
            )

        payload = {
            "batch_id": str(uuid.uuid4()),
            "gathered_at": datetime.now(timezone.utc).isoformat(),
            "items": items,
            "watermarks": [
                {
                    "source": w.source,
                    "watermark": w.watermark.isoformat()
                    if hasattr(w.watermark, "isoformat")
                    else w.watermark,
                }
                for w in (watermarks or [])
            ],
        }

        if dry:
            # A dry run validates and reports, and posts nothing. The watermarks
            # must not move either, or the next real run would skip what this
            # one only pretended to send.
            return IngestResult(accepted=0, queued=0, sent_to_review=0, rejected=len(items))

        body = self._post(payload)
        return IngestResult(
            accepted=body.get("accepted", 0),
            queued=body.get("queued", 0),
            sent_to_review=body.get("sent_to_review", 0),
            rejected=body.get("rejected", 0),
        )

    def watermarks(self) -> list[Watermark]:
        """The only thing the ingest token may read back (AC21). Everything
        else about the private store is refused, so a leaked token cannot be
        turned into a way to read what was gathered."""
        def send(client: httpx.Client) -> httpx.Response:
            return client.get(
                f"{self.endpoint}/watermarks", headers=self._headers(), timeout=self._timeout
            )

        response = send(self._client) if self._client else send(httpx.Client())
        if response.status_code >= 400:
            raise IngestError(f"could not read the watermarks: {response.status_code}")
        return [
            Watermark(source=row["source"], watermark=row["watermark"]) for row in response.json()
        ]


# -- the CLI entry point ------------------------------------------------------


def load_inbox(path: Path) -> list[dict[str, Any]]:
    """An inbox file is either a list of items or {"items": [...]}."""
    payload = json.loads(path.read_text())
    return payload["items"] if isinstance(payload, dict) else payload


def main(args) -> int:
    """`brain ingest <path> [--dry]` — screen an inbox file and post it.

    It screens again here rather than trusting the file. An inbox file is
    written by a session that may have been interrupted, and the endpoint
    screens a third time anyway (D6); this is the cheap place to catch it.
    """
    from brain.screen import Screen

    path = Path(args.path)
    items = load_inbox(path)
    screen = Screen()

    screened = [screen.screen_item(item) for item in items]
    withheld = [i for i in screened if i["screened"]["withheld"]]
    sending = [i for i in screened if not i["screened"]["withheld"]]

    if withheld:
        print(f"{len(withheld)} item(s) withheld: from a source that is never published")

    if args.dry:
        print(f"dry run: {len(sending)} item(s) would be posted, nothing sent, watermarks unmoved")
        return 0

    result = IngestClient().post_batch(sending)
    print(
        f"accepted {result.accepted}, queued {result.queued}, "
        f"to review {result.sent_to_review}, rejected {result.rejected}"
    )
    return 0
