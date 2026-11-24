"""Reading and writing as yourself, through Supabase's REST API.

Slice 4 builds this; slices 4 and 6 both use it, so like the digest's shape and
the TypeScript screen it belongs to neither on its own.

**Why REST and not a database connection.** `brain review`, `digest` and
`status` run wherever you happen to be. Signing in as yourself means the
owner-only rules (AC8) are what protect the data, rather than a connection
string that would have to live somewhere. No extra database role, and nothing
to leak.

**A setup step this needs.** PostgREST only serves schemas that are on the
project's *exposed schemas* list, and by default that is `public` and
`graphql_public` only. `brain` and `brain_private` have to be added in the
dashboard under API settings, or every call here returns 404 with a message
about the schema not existing. Adding a schema does not weaken anything: row
level security still decides every row.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

URL_ENV = "SUPABASE_URL"
ANON_ENV = "SUPABASE_ANON_KEY"
TOKEN_ENV = "SUPABASE_ACCESS_TOKEN"


class ApiError(RuntimeError):
    pass


class OwnerApi:
    """PostgREST, as the signed-in user. Never the service key: with it every
    policy in the migration would be bypassed and the tier rules would protect
    nothing (D4)."""

    def __init__(
        self,
        base_url: str | None = None,
        anon_key: str | None = None,
        access_token: str | None = None,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get(URL_ENV, "")).rstrip("/")
        self.anon_key = anon_key or os.environ.get(ANON_ENV, "")
        self.access_token = access_token or os.environ.get(TOKEN_ENV, "")
        self._client = client

        if not self.base_url or not self.anon_key:
            raise ApiError(f"{URL_ENV} and {ANON_ENV} must be set; see docs/cloud-setup.md")
        if not self.access_token:
            raise ApiError(
                f"{TOKEN_ENV} is not set. This command reads as you, so it needs your own "
                "sign-in token rather than a key. Sign in once and export it."
            )

    def _headers(self, schema: str, *, write: bool = False) -> dict[str, str]:
        headers = {
            "apikey": self.anon_key,
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json",
        }
        # PostgREST picks the schema from these, and refuses any that is not on
        # the project's exposed-schemas list.
        headers["Content-Profile" if write else "Accept-Profile"] = schema
        return headers

    def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        def send(client: httpx.Client) -> httpx.Response:
            return client.request(method, url, timeout=30.0, **kwargs)

        response = send(self._client) if self._client else send(httpx.Client())

        if response.status_code == 404 and "schema" in response.text.lower():
            raise ApiError(
                "PostgREST does not serve this schema. Add `brain` and `brain_private` to the "
                "project's exposed schemas under API settings, then try again."
            )
        if response.status_code == 401:
            raise ApiError(f"{TOKEN_ENV} was refused; sign in again.")
        if response.status_code >= 400:
            raise ApiError(f"{method} {url} returned {response.status_code}: {response.text[:300]}")
        return response

    # -- the three verbs these commands need --------------------------------

    def select(
        self, schema: str, table: str, params: dict[str, str] | None = None
    ) -> list[dict[str, Any]]:
        """An empty list can mean 'nothing there' or 'nothing you may see', and
        deliberately does not distinguish them: the service never says that a
        row exists at a tier the caller cannot read."""
        response = self._request(
            "GET",
            f"{self.base_url}/rest/v1/{table}",
            headers=self._headers(schema),
            params=params or {},
        )
        return response.json()

    def update(
        self, schema: str, table: str, params: dict[str, str], patch: dict[str, Any]
    ) -> list[dict[str, Any]]:
        headers = self._headers(schema, write=True) | {"Prefer": "return=representation"}
        response = self._request(
            "PATCH", f"{self.base_url}/rest/v1/{table}", headers=headers, params=params, json=patch
        )
        return response.json() if response.content else []

    def insert(self, schema: str, table: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        headers = self._headers(schema, write=True) | {"Prefer": "return=representation"}
        response = self._request(
            "POST", f"{self.base_url}/rest/v1/{table}", headers=headers, json=rows
        )
        return response.json() if response.content else []
