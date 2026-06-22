"""Flash job + endpoints — driven entirely with fakes (no hardware, no dfu-programmer)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.flash.base import FlashBackend, FlashError
from app.flash.job import FlashJob


def _run_to_done(job: FlashJob) -> dict:
    """Drive a job to completion on a fresh loop (no pytest-asyncio in this project)."""

    async def go():
        job.start()
        await job.join()

    asyncio.run(go())
    return job.status()


class FakeBackend(FlashBackend):
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.programmed: Path | None = None

    async def program(self, hex_path, log):
        log("fake: programming")
        self.programmed = hex_path
        if self.fail:
            raise FlashError("fake programmer boom")
        log("fake: 100%")

    async def reset(self, log):
        log("fake: reset")


def _job(tmp_path, *, backend, manual=True, gone=True, back=True):
    hexf = tmp_path / "firmware.hex"
    hexf.write_text(":00000001FF\n")
    calls = {"stop": 0, "start": 0}

    async def stop():
        calls["stop"] += 1

    async def start():
        calls["start"] += 1

    async def fake_send_magic(port, baud, data):
        return None

    async def fake_wait_gone(port, timeout):
        return gone

    async def fake_wait_back(port, timeout):
        return back

    job = FlashJob(
        backend=backend,
        hex_path=hexf,
        port="COMX",
        baud=115200,
        magic=b"BOOT\n",
        manual=manual,
        stop_source=stop,
        start_source=start,
        reboot_timeout=0.1,
        port_back_timeout=0.1,
        send_magic=fake_send_magic,
        wait_port_gone=fake_wait_gone,
        wait_port_back=fake_wait_back,
    )
    return job, calls


def test_manual_success(tmp_path):
    backend = FakeBackend()
    job, calls = _job(tmp_path, backend=backend, manual=True)
    st = _run_to_done(job)
    assert st["state"] == "done"
    assert st["running"] is False
    assert backend.programmed is not None
    assert calls["stop"] == 1 and calls["start"] == 1  # port freed then telemetry resumed
    assert any("fake: programming" in line for line in st["log"])


def test_auto_success_reboots(tmp_path):
    backend = FakeBackend()
    job, _ = _job(tmp_path, backend=backend, manual=False, gone=True)
    st = _run_to_done(job)
    assert st["state"] == "done"
    assert any("bootloader" in line for line in st["log"])


def test_auto_port_never_gone_errors(tmp_path):
    backend = FakeBackend()
    job, calls = _job(tmp_path, backend=backend, manual=False, gone=False)
    st = _run_to_done(job)
    assert st["state"] == "error"
    assert "did not disappear" in st["error"]
    assert calls["start"] == 1  # telemetry restored even on failure


def test_program_failure_surfaces(tmp_path):
    backend = FakeBackend(fail=True)
    job, calls = _job(tmp_path, backend=backend, manual=True)
    st = _run_to_done(job)
    assert st["state"] == "error"
    assert "boom" in st["error"]
    assert calls["start"] == 1


# --- endpoints --------------------------------------------------------------

def test_flash_config(client):
    r = client.get("/api/flash/config")
    assert r.status_code == 200
    body = r.json()
    assert "hex_path" in body and "programmer_available" in body


def test_flash_missing_hex_400(client):
    r = client.post("/api/flash", json={"hex_path": "does-not-exist.hex", "manual": True})
    assert r.status_code == 400


def test_flash_status_idle(client):
    r = client.get("/api/flash")
    assert r.status_code == 200
    assert r.json()["state"] == "idle"


def test_flash_cancel_when_idle_noop(client):
    # cancel is idempotent: harmless no-op when nothing is running (not an error)
    r = client.post("/api/flash/cancel")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_flash_browse_lists_hex(client, tmp_path):
    (tmp_path / "firmware.hex").write_text(":00000001FF\n")
    (tmp_path / "sub").mkdir()
    (tmp_path / "notes.txt").write_text("ignore me")
    r = client.get("/api/flash/browse", params={"dir": str(tmp_path)})
    assert r.status_code == 200
    body = r.json()
    assert [h["name"] for h in body["hex_files"]] == ["firmware.hex"]
    assert "sub" in [d["name"] for d in body["dirs"]]
    assert body["parent"]  # can go up


def test_flash_browse_bad_dir_404(client):
    r = client.get("/api/flash/browse", params={"dir": "Z:/nope/nope/nope"})
    assert r.status_code == 404
