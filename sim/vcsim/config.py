"""Parametre yükleme: shared/config/default.json + sim/configs/<ad>.json + komut satırı üzerine yazmaları."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from . import REPO_ROOT, SHARED_DIR

CONFIG_DIR = REPO_ROOT / "sim" / "configs"


def deep_merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def parse_value(raw: str) -> Any:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def set_path(d: dict, dotted: str, value: Any) -> None:
    """`faults.f=0.2` gibi noktalı yolu ayarlar. `shared.` öneki ortak parametreleri değiştirir."""
    keys = dotted.split(".")
    cur = d
    for k in keys[:-1]:
        cur = cur.setdefault(k, {})
    cur[keys[-1]] = value


def load_config(name_or_path: str = "default", overrides: list[str] | dict | None = None) -> dict:
    path = Path(name_or_path)
    if not path.suffix:
        path = CONFIG_DIR / f"{name_or_path}.json"
    sim_cfg = json.loads(path.read_text(encoding="utf-8"))
    if path.name != "default.json":
        sim_cfg = deep_merge(json.loads((CONFIG_DIR / "default.json").read_text(encoding="utf-8")), sim_cfg)

    if isinstance(overrides, dict):
        sim_cfg = deep_merge(sim_cfg, overrides)
    else:
        for item in overrides or []:
            key, _, raw = item.partition("=")
            set_path(sim_cfg, key.strip(), parse_value(raw.strip()))

    shared = json.loads((SHARED_DIR / "config" / "default.json").read_text(encoding="utf-8"))
    shared = deep_merge(shared, sim_cfg.pop("shared", {}) or {})
    shared.pop("_comment", None)
    sim_cfg.pop("_comment", None)
    return {"shared": shared, **sim_cfg}
