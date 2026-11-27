"""Loads the language-neutral vectors from ``spec/test-vectors`` (override with PX402_VECTORS_DIR)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List

VECTORS_DIR = Path(
    os.environ.get("PX402_VECTORS_DIR", Path(__file__).resolve().parents[3] / "spec" / "test-vectors")
)

VECTOR_FILES = (
    "header-codec.json",
    "validation.json",
    "requirement-matching.json",
    "client-transcripts.json",
    "error-codes.json",
    "paywall-transcripts.json",
)


def load(name: str) -> Dict[str, Any]:
    with open(VECTORS_DIR / name, encoding="utf-8") as handle:
        data = json.load(handle)
    assert data["formatVersion"] == 1, f"{name}: unsupported formatVersion {data['formatVersion']}"
    return data


def cases(name: str) -> List[Dict[str, Any]]:
    return load(name)["cases"]


def ids(items: List[Dict[str, Any]]) -> List[str]:
    return [item["id"] for item in items]
