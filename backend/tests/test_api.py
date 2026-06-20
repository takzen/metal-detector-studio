"""Integration tests for the record / replay / delete REST endpoints.

Uses the real FastAPI app (via the ``client`` fixture) with the serial source pointed
at a non-existent port and recordings redirected to a tmp dir.
"""

from __future__ import annotations

from conftest import write_recording


def test_record_start_stop_and_list(client):
    r = client.post("/api/record", json={"action": "start"})
    assert r.status_code == 200, r.text
    assert r.json()["recording"] is True

    r = client.post("/api/record", json={"action": "stop"})
    assert r.status_code == 200
    body = r.json()
    assert body["recording"] is False
    name = body["path"]

    recs = client.get("/api/recordings").json()["recordings"]
    assert any(x["name"] == name for x in recs)


def test_double_start_conflicts(client):
    assert client.post("/api/record", json={"action": "start"}).status_code == 200
    assert client.post("/api/record", json={"action": "start"}).status_code == 409
    client.post("/api/record", json={"action": "stop"})


def test_stop_without_recording_conflicts(client):
    assert client.post("/api/record", json={"action": "stop"}).status_code == 409


def test_replay_switches_source(client, rec_dir):
    write_recording(rec_dir / "rec-x.ndjson")
    r = client.post("/api/source", json={"source": "replay", "file": "rec-x.ndjson", "loop": True})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "replay"
    assert client.get("/api/health").json()["source"] == "replay"


def test_replay_missing_file_404(client):
    r = client.post("/api/source", json={"source": "replay", "file": "nope.ndjson"})
    assert r.status_code == 404


def test_delete_recording(client, rec_dir):
    write_recording(rec_dir / "rec-del.ndjson")
    r = client.delete("/api/recordings/rec-del.ndjson")
    assert r.status_code == 200
    assert not (rec_dir / "rec-del.ndjson").exists()


def test_delete_invalid_name_400(client):
    assert client.delete("/api/recordings/evil.txt").status_code == 400


def test_delete_missing_404(client, rec_dir):
    rec_dir.mkdir(parents=True, exist_ok=True)
    assert client.delete("/api/recordings/ghost.ndjson").status_code == 404


def test_cannot_delete_active_replay(client, rec_dir):
    write_recording(rec_dir / "rec-active.ndjson")
    client.post("/api/source", json={"source": "replay", "file": "rec-active.ndjson", "loop": True})
    assert client.delete("/api/recordings/rec-active.ndjson").status_code == 409
