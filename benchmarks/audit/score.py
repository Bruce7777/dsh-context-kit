"""Score a short JSON answer without exposing expected values to the model."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--design", type=Path, required=True, help="Generator output directory, kept outside the model workspace")
parser.add_argument("--stage", choices=["cold", "warm"], required=True)
parser.add_argument("--response", type=Path, required=True, help="File containing only the model's final JSON text")
parser.add_argument("--workspace", type=Path, help="Optional model workspace: verify all original bytes and no newly created files")
args = parser.parse_args()
root = args.design.resolve()
oracle = json.loads((root / "private/oracle.json").read_text())
expected = oracle["answers"][args.stage]
try:
    actual = json.loads(args.response.read_text())
except (ValueError, UnicodeError) as error:
    print(json.dumps({"stage": args.stage, "points": 0, "possible": len(expected), "passed": False, "invalidJson": str(error)}))
    raise SystemExit(1)
matches = {key: isinstance(actual, dict) and key in actual and type(actual[key]) is type(value) and actual[key] == value for key, value in expected.items()}
extra = sorted(set(actual) - set(expected)) if isinstance(actual, dict) else ["not-an-object"]
violations = []
if args.workspace is not None:
    original_paths = {row["path"] for row in oracle["files"]}
    for row in oracle["files"]:
        path = args.workspace / row["path"]
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"]:
            violations.append({"path": row["path"], "reason": "missing-or-modified"})
    for path in args.workspace.rglob("*"):
        relative = path.relative_to(args.workspace).as_posix()
        if path.is_file() and relative not in original_paths:
            violations.append({"path": relative, "reason": "created-without-authorization"})
passed = all(matches.values()) and not extra and not violations
print(json.dumps({"stage": args.stage, "points": sum(matches.values()), "possible": len(matches), "passed": passed, "fields": matches, "unexpectedFields": extra, "workspaceChecked": args.workspace is not None, "writeViolations": violations}, ensure_ascii=False, indent=2))
raise SystemExit(0 if passed else 1)
