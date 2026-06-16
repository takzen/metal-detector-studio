"""Validate device profile(s) and print readable errors.

JSON has no comments, so this is how you check a profile you filled in by hand.

Usage (from the backend/ directory):
    uv run python -m app.validate_profile              # validate ALL profiles/*.json
    uv run python -m app.validate_profile myrig        # validate profiles/myrig.json by id
    uv run python -m app.validate_profile path/to.json # validate a specific file

Exit code 0 = all valid, 1 = at least one problem (handy in CI / pre-commit).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from pydantic import ValidationError

from . import config
from .profiles import Profile, list_profiles


def _validate_file(path: Path) -> bool:
    """Validate one profile file; print a one-line OK or a readable error list."""
    name = path.name
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"  FAIL {name}: file not found ({path})")
        return False
    except json.JSONDecodeError as exc:
        print(f"  FAIL {name}: invalid JSON at line {exc.lineno}, col {exc.colno}: {exc.msg}")
        return False

    try:
        prof = Profile.model_validate(data)
    except ValidationError as exc:
        print(f"  FAIL {name}: {exc.error_count()} problem(s):")
        for err in exc.errors():
            loc = ".".join(str(p) for p in err["loc"]) or "(root)"
            print(f"      - {loc}: {err['msg']}")
        return False

    note = "" if prof.synth else "  (no synth block; real-device profiles can omit it)"
    diffs = f", {len(prof.phase_diffs)} phase-diff(s)" if prof.phase_diffs else ""
    print(f"  OK   {name}: id={prof.id!r}, {len(prof.harmonics)} harmonic(s){diffs}{note}")
    return True


def main(argv: list[str]) -> int:
    args = argv[1:]

    if not args:
        ids = list_profiles()
        if not ids:
            print(f"No profiles found in {config.PROFILES_DIR}")
            return 1
        print(f"Validating {len(ids)} profile(s) in {config.PROFILES_DIR}:")
        results = [_validate_file(config.PROFILES_DIR / f"{pid}.json") for pid in ids]
        ok = all(results)
        print(f"\n{sum(results)}/{len(results)} valid." if ok else f"\n{results.count(False)} of {len(results)} FAILED.")
        return 0 if ok else 1

    target = args[0]
    path = Path(target)
    if path.suffix.lower() != ".json":
        path = config.PROFILES_DIR / f"{target}.json"  # treat the arg as a profile id
    return 0 if _validate_file(path) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
