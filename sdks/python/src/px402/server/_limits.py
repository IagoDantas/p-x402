"""Client IP keys and the sliding-window limiter (``packages/server/src/ip.ts``, ``core/rate-limit.ts``)."""

from __future__ import annotations

import math
import re
import threading
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

#: Shared rate-limit bucket for requests whose client IP is unknown.
UNKNOWN_IP_KEY = "unknown"

_IPV4 = re.compile(r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})", re.ASCII)
_HEXTET = re.compile(r"[0-9a-f]{1,4}", re.ASCII)
_MAPPED = re.compile(r"[0:]*ffff:(\d{1,3}(?:\.\d{1,3}){3})", re.ASCII)


def _expand_ipv6(ip: str) -> Optional[List[str]]:
    halves = ip.split("::")
    if len(halves) > 2:
        return None
    head = halves[0].split(":") if halves[0] else []
    tail = halves[1].split(":") if len(halves) > 1 and halves[1] else []
    last = tail[-1] if tail else (head[-1] if head else None)
    v4_groups = 1 if last is not None and _IPV4.fullmatch(last) else 0
    missing = 8 - len(head) - len(tail) - v4_groups
    if len(halves) == 1 and missing != 0:
        return None
    if len(halves) == 2 and missing < 1:
        return None
    groups = head + ["0"] * (missing if len(halves) == 2 else 0) + tail
    return [format(int(g, 16), "x") if _HEXTET.fullmatch(g) else g for g in groups]


def client_ip_key(ip: Optional[str]) -> str:
    """IPv4 as is, IPv4-mapped IPv6 as the IPv4 address, other IPv6 by /64. Missing → "unknown"."""
    raw = (ip or "").strip().lower()
    if not raw:
        return UNKNOWN_IP_KEY
    if ":" not in raw:
        return raw
    bare = re.sub(r"%.*$", "", re.sub(r"^\[|\]$", "", raw), flags=re.S)
    mapped = _MAPPED.fullmatch(bare)
    if mapped:
        return mapped.group(1)
    groups = _expand_ipv6(bare)
    if not groups:
        return bare
    return ":".join(groups[:4]) + "::/64"


@dataclass(frozen=True)
class RateLimitResult:
    ok: bool
    retry_after_seconds: int = 0


class RateLimiter:
    """Sliding window kept in memory; a refused hit is not counted. Times in milliseconds."""

    def __init__(self, limit: int, window_ms: float, now_ms: Callable[[], float]) -> None:
        self.limit = limit
        self.window_ms = window_ms
        self._now_ms = now_ms
        self._hits: Dict[str, List[float]] = {}
        self._calls = 0
        self._lock = threading.Lock()

    def take(self, key: str) -> RateLimitResult:
        with self._lock:
            t = self._now_ms()
            window_start = t - self.window_ms
            recent = [at for at in self._hits.get(key, []) if at > window_start]
            self._calls += 1
            if self._calls % 1000 == 0:
                for k in [k for k, hits in self._hits.items() if all(at <= window_start for at in hits)]:
                    del self._hits[k]
            if len(recent) >= self.limit:
                self._hits[key] = recent
                oldest = recent[0] if recent else t
                retry_ms = oldest + self.window_ms - t
                return RateLimitResult(False, max(1, math.ceil(retry_ms / 1000)))
            recent.append(t)
            self._hits[key] = recent
            return RateLimitResult(True)
