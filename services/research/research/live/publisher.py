"""Redis Streams publisher for signals (validated on write)."""

from __future__ import annotations

import redis

from ..contracts import STREAMS, Signal
from ..settings import settings

_client: redis.Redis | None = None


def client() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    return _client


def publish_signal(sig: Signal, r: redis.Redis | None = None) -> str:
    payload = sig.model_dump_json(exclude_none=True)
    Signal.model_validate_json(payload)  # producer validates on write
    return (r or client()).xadd(STREAMS["signals"], {"json": payload}, maxlen=10_000, approximate=True)
