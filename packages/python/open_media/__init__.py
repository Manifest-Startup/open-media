"""Open Media: the official Python client for the Open Media API.

Public data (the mixed feed, cross-network search, posts, profiles, timelines and events) needs no
key. Account calls need the person's own access token, copied from the app (Settings, then
Developers and agents), and act only as that person.

Apps that sign people in with "Sign in with Open Media" (OAuth) pass that access token with
``connected=True``: account calls then go to /v1/connected/me/... (ADR 0041). ``verify_webhook``
checks the signed webhooks Open Media sends to integrated apps.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from typing import Any, Callable, Dict, List, Optional
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

__all__ = ["OpenMedia", "OpenMediaError", "DEFAULT_BASE_URL", "verify_webhook"]
__version__ = "0.2.0"

DEFAULT_BASE_URL = "https://api.openmedia.site"
NETWORKS = ("open-media", "farcaster", "lens", "hive", "deso")


class OpenMediaError(Exception):
    """An API error with the server's machine-readable code."""

    def __init__(self, status: int, code: str, message: str, retry_after: Optional[int] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after


Opener = Callable[[Request, float], Any]


class OpenMedia:
    """A client for the Open Media API."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, token: Optional[str] = None, max_retries: int = 2,
                 timeout: float = 30.0, user_agent: Optional[str] = None, opener: Optional[Opener] = None,
                 connected: bool = False):
        self.base_url = base_url.rstrip("/")
        # An OAuth ("Sign in with Open Media") token: account calls use /v1/connected/me/...
        self.connected = connected
        self.token = token
        self.max_retries = max_retries
        self.timeout = timeout
        self.user_agent = " ".join(filter(None, [f"open-media-python/{__version__}", user_agent]))
        self._open = opener or (lambda request, timeout: urlopen(request, timeout=timeout))

    # Public: no key
    def feed(self, sources: Optional[List[str]] = None, mode: Optional[str] = None, kind: Optional[str] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        """The mixed feed across Open Media and the open networks, with "why" reasons."""
        return self._get("/v1/feed", {"sources": ",".join(sources) if sources else None, "mode": mode, "kind": kind, "cursor": cursor})

    def search(self, query: str) -> Dict[str, Any]:
        """Plain-language search across public posts on every network, plus matching settings."""
        return self._get("/v1/search", {"q": query})

    def post(self, post_id: str) -> Dict[str, Any]:
        return self._get(f"/v1/posts/{quote(post_id, safe='')}")

    def profile(self, handle: str) -> Dict[str, Any]:
        return self._get(f"/v1/profiles/{quote(handle.lstrip('@'), safe='')}")

    def timeline(self, network: str, handle: str, cursor: Optional[str] = None) -> Dict[str, Any]:
        if network not in NETWORKS:
            raise ValueError(f"network must be one of {', '.join(NETWORKS)}")
        return self._get(f"/v1/people/{network}/{quote(handle.lstrip('@'), safe='')}", {"cursor": cursor})

    def events(self, area: Optional[str] = None, days: Optional[int] = None, query: Optional[str] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        """Upcoming public events in the San Francisco Bay Area, with official registration links."""
        return self._get("/v1/events/upcoming", {"area": area, "days": days, "q": query, "limit": limit})

    def app_posts(self, app: str, kind: Optional[str] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        """One integrated app's public posts (kind="clips": videos only) with context and counts."""
        return self._get("/v1/feed", {"app": app, "kind": kind, "cursor": cursor})

    def networks(self) -> Dict[str, Any]:
        return self._get("/v1/networks")

    def about(self) -> Dict[str, Any]:
        return self._get("/v1/about")

    # The person's account: needs their token
    def request_sign_in_code(self, email: str) -> Dict[str, Any]:
        """Step 1 of signing in: Open Media emails the person a code (new emails get a new account)."""
        return self._send("POST", "/v1/auth/email-code", {"email": email})

    def sign_in_with_code(self, email: str, code: str) -> Dict[str, Any]:
        """Step 2: the code the person read from their email. The client then acts as them."""
        session = self._send("POST", "/v1/auth/verify", {"email": email, "code": code})
        self.token = session["access_token"]
        return session

    def refresh_session(self, refresh_token: str) -> Dict[str, Any]:
        session = self._send("POST", "/v1/auth/refresh", {"refresh_token": refresh_token})
        self.token = session["access_token"]
        return session

    def set_up_profile(self, display_name: str, handle: str) -> Dict[str, Any]:
        """For a new account: the name and handle the person chose."""
        return self._send("PUT", "/v1/me/profile", {"displayName": display_name, "handle": handle})

    def me(self) -> Dict[str, Any]:
        return self._get("/v1/me")

    def publish(self, text: str, idempotency_key: Optional[str] = None, video: Optional[Dict[str, Any]] = None,
                context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Publishes a public post. Pass the same idempotency_key when retrying.

        ``video`` is the object ``upload_video`` returned (text may then be empty); ``context`` is an
        app context such as {"app": "manifest", "idea_id": "42", "url": "https://manifeststartup.com/..."}.
        """
        body: Dict[str, Any] = {"text": text}
        if video is not None:
            body["video"] = video
        if context is not None:
            body["context"] = context
        return self._send("POST", "/v1/me/posts", body, idempotency_key)

    def upload_video(self, data: bytes, content_type: str = "video/mp4") -> Dict[str, Any]:
        """Uploads an MP4, MOV or WebM (at most 100 MB) as the raw body. Pass the result to publish."""
        return self._request("POST", "/v1/me/media/videos", {}, raw=(data, content_type))["video"]

    def like_post(self, post_id: str, liked: bool = True) -> Dict[str, Any]:
        return self._send("PUT" if liked else "DELETE", f"/v1/me/posts/{quote(post_id, safe='')}/like")

    def comments(self, post_id: str) -> Dict[str, Any]:
        return self._get(f"/v1/me/posts/{quote(post_id, safe='')}/comments")

    def comment(self, post_id: str, text: str) -> Dict[str, Any]:
        return self._send("POST", f"/v1/me/posts/{quote(post_id, safe='')}/comments", {"body": text})

    def my_feed(self, app: Optional[str] = None, kind: Optional[str] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        """Your feed; with app, only that app's posts, each with viewer.liked."""
        return self._get("/v1/me/feed", {"app": app, "kind": kind, "cursor": cursor})

    def delete_post(self, post_id: str) -> Dict[str, Any]:
        return self._send("DELETE", f"/v1/me/posts/{quote(post_id, safe='')}")

    def conversations(self, app: Optional[str] = None) -> Dict[str, Any]:
        """Your conversations; ``conversations`` is the app shape, ``data`` the original."""
        return self._get("/v1/me/conversations", {"app": app})

    def start_conversation(self, handle: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Opens (or re-uses) the direct conversation with a handle; context is set only if it has none."""
        body: Dict[str, Any] = {"handle": handle}
        if context is not None:
            body["context"] = context
        return self._send("POST", "/v1/me/conversations", body)

    def messages(self, conversation_id: str, limit: Optional[int] = None, before: Optional[str] = None) -> Dict[str, Any]:
        """Messages, newest last. ``before`` is a message id or an ISO time."""
        return self._get(f"/v1/me/conversations/{quote(conversation_id, safe='')}/messages", {"limit": limit, "before": before})

    def send_message(self, conversation_id: str, text: str, client_id: Optional[str] = None) -> Dict[str, Any]:
        """Sends a message. The same client_id makes a retry land once."""
        body: Dict[str, Any] = {"body": text}
        if client_id:
            body["client_id"] = client_id
        return self._send("POST", f"/v1/me/conversations/{quote(conversation_id, safe='')}/messages", body, client_id)

    def mark_read(self, conversation_id: str) -> Dict[str, Any]:
        return self._send("POST", f"/v1/me/conversations/{quote(conversation_id, safe='')}/read")

    def realtime_token(self) -> Dict[str, Any]:
        """The person's own short-lived session for Supabase Realtime: supabase_url, anon_key, access_token, expires_at."""
        return self._send("POST", "/v1/me/realtime-token")

    def payment_setup(self) -> Dict[str, Any]:
        return self._get("/v1/me/payments/setup")

    def payments(self, limit: int = 50) -> List[Dict[str, Any]]:
        return self._get("/v1/me/payments", {"limit": limit})

    def start_payment(self, context_type: str, context_id: str, rail: str, chain: Optional[str] = None,
                      amount_minor: Optional[int] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Starts a payment once the person agreed to the recipient, amount and fees.

        Card returns checkoutUrl for the person to open; USDC returns the transfer for their own wallet.
        Nothing is paid until Stripe or the network confirms it.
        """
        body: Dict[str, Any] = {"contextType": context_type, "contextId": context_id, "rail": rail}
        if chain:
            body["chain"] = chain
        if amount_minor is not None:
            body["amountMinor"] = amount_minor
        return self._send("POST", "/v1/me/payments", body, idempotency_key)

    def export_data(self) -> Dict[str, Any]:
        return self._get("/v1/me/export")

    # Plumbing
    def _get(self, path: str, query: Optional[Dict[str, Any]] = None) -> Any:
        return self._request("GET", path, query or {})

    def _send(self, method: str, path: str, body: Any = None, idempotency_key: Optional[str] = None) -> Any:
        return self._request(method, path, {}, body, idempotency_key)

    def _request(self, method: str, path: str, query: Dict[str, Any], body: Any = None, idempotency_key: Optional[str] = None,
                 raw: Optional[tuple] = None) -> Any:
        if self.connected and (path == "/v1/me" or path.startswith("/v1/me/")):
            path = "/v1/connected" + path[3:]
        params = {key: value for key, value in query.items() if value not in (None, "")}
        url = f"{self.base_url}{path}" + (f"?{urlencode(params)}" if params else "")
        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        if raw is not None:
            data, headers["Content-Type"] = raw[0], raw[1]
        if method != "GET":
            # One key for every retry of a write, so a retry never creates a second post or payment.
            headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
        attempt = 0
        while True:
            request = Request(url, data=data, method=method, headers=headers)
            try:
                with self._open(request, self.timeout) as response:
                    text = response.read().decode()
                    return json.loads(text) if text else None
            except HTTPError as error:
                text = error.read().decode() if error.fp else ""
                retry_after = error.headers.get("Retry-After") if error.headers else None
                retry_seconds = int(retry_after) if retry_after and retry_after.isdigit() else None
                if error.code == 429 and attempt < self.max_retries:
                    attempt += 1
                    time.sleep(retry_seconds if retry_seconds is not None else 1)
                    continue
                try:
                    payload = json.loads(text) if text else {}
                except ValueError:
                    payload = {}
                # Account routes answer {"error": {"code", "message"}}; /v1/connected and OAuth {"error", "error_description"}.
                problem = payload.get("error") if isinstance(payload, dict) else None
                description = payload.get("error_description") if isinstance(payload, dict) else None
                if isinstance(problem, dict):
                    code, message = problem.get("code") or f"http_{error.code}", problem.get("message") or f"Open Media answered {error.code}."
                else:
                    code = problem if isinstance(problem, str) and problem else f"http_{error.code}"
                    message = description or problem or f"Open Media answered {error.code}."
                raise OpenMediaError(error.code, code, message, retry_seconds) from None


def verify_webhook(secret: str, headers: Dict[str, str], raw_body: bytes, tolerance_seconds: int = 300,
                   now: Optional[float] = None) -> bool:
    """Checks an Open Media webhook (ADR 0041).

    The signature is ``sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`` and the timestamp
    must be within ``tolerance_seconds``. Pass the raw body exactly as received, and dedupe on its ``id``.
    """
    lowered = {key.lower(): value for key, value in headers.items()}
    timestamp = lowered.get("x-open-media-timestamp", "")
    signature = lowered.get("x-open-media-signature", "")
    if not timestamp.isdigit() or abs((now if now is not None else time.time()) - int(timestamp)) > tolerance_seconds:
        return False
    body = raw_body if isinstance(raw_body, bytes) else str(raw_body).encode()
    expected = "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
