"""Read-only clients for Polymarket's public APIs (no auth needed).

* Gamma API  (gamma-api.polymarket.com): market & event metadata
* CLOB API   (clob.polymarket.com):      order books, midpoints, price history
* Data API   (data-api.polymarket.com):  public positions & trades by wallet

Standard library only; honours HTTPS_PROXY via urllib.
"""

from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.parse
import urllib.request

from pmbot.models import Market, OrderBook

log = logging.getLogger(__name__)

GAMMA_URL = "https://gamma-api.polymarket.com"
CLOB_URL = "https://clob.polymarket.com"
DATA_URL = "https://data-api.polymarket.com"


class ApiError(RuntimeError):
    pass


class HttpClient:
    def __init__(self, base_url: str, timeout: float = 10.0, retries: int = 4, min_interval: float = 0.05):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self.min_interval = min_interval  # crude client-side rate limit
        self._last = 0.0

    def request(self, method: str, path: str, params: dict | None = None, body=None):
        url = f"{self.base_url}{path}"
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}, doseq=True)
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Accept": "application/json", "User-Agent": "pmbot/0.1"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        delay = 0.5
        for attempt in range(self.retries + 1):
            wait = self.min_interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                req = urllib.request.Request(url, data=data, method=method, headers=headers)
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return json.loads(resp.read().decode() or "null")
            except urllib.error.HTTPError as exc:
                retryable = exc.code == 429 or exc.code >= 500
                if not retryable or attempt == self.retries:
                    raise ApiError(f"{method} {url} -> HTTP {exc.code}: {exc.read()[:200]!r}") from exc
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                if attempt == self.retries:
                    raise ApiError(f"{method} {url} failed: {exc}") from exc
            sleep_for = delay * (1 + random.random() * 0.25)
            log.debug("retrying %s %s in %.1fs", method, path, sleep_for)
            time.sleep(sleep_for)
            delay *= 2

    def get(self, path: str, **params):
        return self.request("GET", path, params=params)

    def post(self, path: str, body):
        return self.request("POST", path, body=body)


class GammaClient:
    def __init__(self, http: HttpClient | None = None):
        self.http = http or HttpClient(GAMMA_URL)

    def markets(self, limit: int = 100, offset: int = 0, order: str = "volume24hr", **filters) -> list[dict]:
        params = {"limit": limit, "offset": offset, "order": order, "ascending": "false",
                  "active": "true", "closed": "false", **filters}
        return self.http.get("/markets", **params) or []

    def active_markets(self, max_markets: int = 500, page: int = 100) -> list[Market]:
        out: list[Market] = []
        offset = 0
        while len(out) < max_markets:
            raw = self.markets(limit=page, offset=offset)
            if not raw:
                break
            for r in raw:
                m = Market.from_gamma(r)
                if m is not None:
                    out.append(m)
            if len(raw) < page:
                break
            offset += page
        return out[:max_markets]

    def market_by_slug(self, slug: str) -> Market | None:
        raw = self.http.get("/markets", slug=slug) or []
        return Market.from_gamma(raw[0]) if raw else None

    def events(self, limit: int = 50, offset: int = 0, **filters) -> list[dict]:
        params = {"limit": limit, "offset": offset, "order": "volume24hr", "ascending": "false",
                  "active": "true", "closed": "false", **filters}
        return self.http.get("/events", **params) or []


class ClobPublicClient:
    BATCH = 50  # tokens per POST /books request

    def __init__(self, http: HttpClient | None = None):
        self.http = http or HttpClient(CLOB_URL)

    def book(self, token_id: str) -> OrderBook:
        return OrderBook.from_api(self.http.get("/book", token_id=token_id))

    def books(self, token_ids: list[str]) -> dict[str, OrderBook]:
        out: dict[str, OrderBook] = {}
        for i in range(0, len(token_ids), self.BATCH):
            chunk = token_ids[i:i + self.BATCH]
            raw = self.http.post("/books", [{"token_id": t} for t in chunk]) or []
            for r in raw:
                ob = OrderBook.from_api(r)
                out[ob.token_id] = ob
        return out

    def midpoint(self, token_id: str) -> float | None:
        raw = self.http.get("/midpoint", token_id=token_id) or {}
        return float(raw["mid"]) if raw.get("mid") is not None else None

    def price_history(self, token_id: str, interval: str = "1w", fidelity: int = 5) -> list[tuple[int, float]]:
        raw = self.http.get("/prices-history", market=token_id, interval=interval, fidelity=fidelity) or {}
        return [(int(p["t"]), float(p["p"])) for p in raw.get("history", [])]


class DataClient:
    def __init__(self, http: HttpClient | None = None):
        self.http = http or HttpClient(DATA_URL)

    def positions(self, wallet: str) -> list[dict]:
        return self.http.get("/positions", user=wallet, sizeThreshold=0) or []

    def trades(self, market_condition_id: str | None = None, user: str | None = None, limit: int = 100) -> list[dict]:
        return self.http.get("/trades", market=market_condition_id, user=user, limit=limit) or []

    def activity(self, user: str, limit: int = 500, offset: int = 0) -> list[dict]:
        return self.http.get("/activity", user=user, limit=limit, offset=offset) or []
