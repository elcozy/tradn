"""Pydantic models generated from packages/contracts/schemas. Run `pnpm gen` to (re)generate."""

from .streams import CONTRACT_VERSION, STREAMS  # noqa: F401

try:
    from .gen import EngineCommand, EngineEvent, Signal  # noqa: F401
except ImportError as e:  # pragma: no cover
    raise ImportError("contracts not generated; run `pnpm gen`") from e
