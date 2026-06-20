"""Frame validation against the telemetry grammar (schema.json), Milestone H.

``schema.json`` is a compact custom grammar (not a JSON-Schema document): each packet
lists its fields with a short ``type`` string (``uint32``, ``float``, ``array<int16>``,
``map<string, harmonic_sample>``, ...). This module translates that grammar into real
JSON-Schema (Draft 2020-12) validators — one per ``device->pc`` packet — so every frame
the backend broadcasts can be checked against the published contract.

A :class:`FrameValidator` keeps cumulative ok/bad counters (surfaced by ``/api/health``
next to the serial link stats), turning silent contract drift between the pydantic
models and ``schema.json`` into a visible number.
"""

from __future__ import annotations

from jsonschema import Draft202012Validator

# grammar scalar -> JSON-Schema fragment
_SCALARS = {
    "string": {"type": "string"},
    "bool": {"type": "boolean"},
    "float": {"type": "number"},
    "uint32": {"type": "integer"},
    "uint16": {"type": "integer"},
    "int32": {"type": "integer"},
    "int16": {"type": "integer"},
    "int8": {"type": "integer"},
    "uint8": {"type": "integer"},
    "int": {"type": "integer"},
    "object": {"type": "object"},
}


def _type_to_schema(t: str, types: dict) -> dict | bool:
    """Translate one grammar type string into a JSON-Schema fragment.

    Handles scalars, ``array<INNER>``, ``map<string, INNER>`` and named subtypes
    declared in a packet's ``types`` block (e.g. ``harmonic_sample``). Unknown types
    fall back to ``True`` (accept anything) rather than failing the whole frame.
    """
    t = t.strip()
    if t == "any":
        return True
    if t in _SCALARS:
        return dict(_SCALARS[t])
    if t.startswith("array<") and t.endswith(">"):
        return {"type": "array", "items": _type_to_schema(t[6:-1], types)}
    if t.startswith("map<") and t.endswith(">"):
        _, _, val = t[4:-1].partition(",")
        return {"type": "object", "additionalProperties": _type_to_schema(val, types)}
    if t in types:
        props = {k: _type_to_schema(v["type"], types) for k, v in types[t].items()}
        return {"type": "object", "properties": props, "required": list(props)}
    return True  # unknown subtype -> permissive


def _packet_schema(packet: dict) -> dict:
    """Build the object schema for one packet from its ``fields`` (+ local ``types``)."""
    types = packet.get("types", {})
    props: dict = {}
    required: list[str] = []
    for name, spec in packet["fields"].items():
        sub = _type_to_schema(spec["type"], types)
        if isinstance(sub, dict) and "const" in spec:
            sub = {**sub, "const": spec["const"]}
        props[name] = sub
        required.append(name)
    # additionalProperties stays open: frames may carry forward-compatible extra keys;
    # we validate shapes/types of declared fields, not the absence of new ones.
    return {"type": "object", "properties": props, "required": required}


class FrameValidator:
    """Validates broadcast frames against schema.json and counts pass/fail."""

    def __init__(self, schema: dict) -> None:
        self._validators: dict[str, Draft202012Validator] = {}
        for ptype, packet in schema.get("packets", {}).items():
            if packet.get("direction") != "device->pc":
                continue  # only validate frames the backend actually emits
            self._validators[ptype] = Draft202012Validator(_packet_schema(packet))
        self.frames_ok = 0
        self.frames_bad = 0
        self.skipped = 0  # frames whose type has no schema entry
        self.last_error = ""

    def check(self, frame: dict) -> bool:
        """Validate one frame dict; update counters. Returns True if valid/unknown."""
        validator = self._validators.get(frame.get("type", ""))
        if validator is None:
            self.skipped += 1
            return True
        err = next(validator.iter_errors(frame), None)
        if err is None:
            self.frames_ok += 1
            return True
        self.frames_bad += 1
        path = "/".join(str(p) for p in err.absolute_path)
        self.last_error = f"{frame.get('type')}{'/' + path if path else ''}: {err.message}"[:200]
        return False

    def stats(self) -> dict:
        return {
            "frames_ok": self.frames_ok,
            "frames_bad": self.frames_bad,
            "skipped": self.skipped,
            "last_error": self.last_error,
        }
