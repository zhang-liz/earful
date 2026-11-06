"""espeak-ng gives up on a long data folder, so Earful copies it somewhere short."""

import sys
import types

import espeakng_loader
import pytest

from app import engine


@pytest.fixture
def loader(monkeypatch, tmp_path):
    """espeakng_loader with its data in a folder of the given length."""

    def place(length: int):
        base = tmp_path / "x"
        pad = length - len(str(base.resolve())) - len("/espeak-ng-data")
        data = tmp_path / ("x" * pad) / "espeak-ng-data"
        (data / "voices").mkdir(parents=True)
        (data / "phontab").write_bytes(b"sounds")
        monkeypatch.setattr(espeakng_loader, "get_data_path", lambda: str(data))
        return data

    cache = tmp_path / "cache"
    monkeypatch.setattr(engine, "_cache_folders", lambda: [cache])
    monkeypatch.delitem(sys.modules, "misaki.espeak", raising=False)
    return place, cache


def test_a_short_path_is_left_alone(loader):
    place, cache = loader
    data = place(120)
    engine.use_short_espeak_data()
    assert espeakng_loader.get_data_path() == str(data)
    assert not cache.exists()


def test_a_long_path_is_copied_somewhere_short(loader):
    place, cache = loader
    place(200)
    engine.use_short_espeak_data()
    used = espeakng_loader.get_data_path()
    assert len(used) <= engine.ESPEAK_PATH_LIMIT
    assert (cache / "espeak-ng-data" / "phontab").read_bytes() == b"sounds"
    assert used == str((cache / "espeak-ng-data").resolve())


def test_the_copy_is_made_once(loader):
    place, cache = loader
    place(200)
    engine.use_short_espeak_data()
    (cache / "espeak-ng-data" / "phontab").write_bytes(b"kept")
    engine.use_short_espeak_data()
    assert (cache / "espeak-ng-data" / "phontab").read_bytes() == b"kept"


def test_espeak_already_loaded_is_pointed_at_the_copy(loader, monkeypatch):
    place, cache = loader
    place(200)
    told = []
    wrapper = types.SimpleNamespace(set_data_path=told.append)
    monkeypatch.setitem(sys.modules, "misaki.espeak", types.SimpleNamespace(EspeakWrapper=wrapper))
    engine.use_short_espeak_data()
    assert told == [str((cache / "espeak-ng-data").resolve())]


def test_a_read_only_app_is_copied_too(loader):
    """A downloaded app can be read-only; the copy must still work."""
    place, cache = loader
    data = place(200)
    for path in [*data.rglob("*"), data]:
        path.chmod(path.stat().st_mode & ~0o222)
    try:
        engine.use_short_espeak_data()
        assert espeakng_loader.get_data_path() == str((cache / "espeak-ng-data").resolve())
        assert (cache / "espeak-ng-data" / "phontab").read_bytes() == b"sounds"
        assert [p.name for p in cache.iterdir() if p.name.startswith("tmp")] == [], "staging left behind"
    finally:
        for path in [data, *data.rglob("*")]:
            path.chmod(path.stat().st_mode | 0o200)
