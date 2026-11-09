"""Independently derive answers from evidence and check positive/negative grading."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

CODE_ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("design", type=Path, help="Generator output directory")
ROOT = parser.parse_args().design.resolve()
oracle = json.loads((ROOT / "private/oracle.json").read_text())
events = []
for path in sorted((ROOT / "model-workspace/records").glob("audit-*.jsonl")):
    events.extend(json.loads(line) for line in path.read_text().splitlines())
target = [event for event in events if event.get("caseId") == oracle["caseId"]]
attestation = next(event for event in target if event["kind"] == "release_attestation")
retry = next(event for event in target if event["kind"] == "retry_incident")
policy = next(event for event in target if event["kind"] == "read_only_policy")
original = next(event for event in target if event["kind"] == "declared_configuration")
configuration = dict(original)
ledger = {row["invoiceId"]: dict(row) for event in target if event["kind"] == "invoice_ledger" for row in event["entries"]}
revoked_id, reinstated_id = None, None
for event in target:
    if event["kind"] == "amendment" and event["status"] == "approved":
        configuration.update({key: event[key] for key in ("effectiveLimit", "endpoint") if key in event})
    if event["kind"] == "ledger_amendment" and event["status"] == "approved":
        for change in event["changes"]:
            row = ledger[change["invoiceId"]]
            assert row["state"] == change["from"]
            row["state"] = change["to"]
            if change["reason"] == "duplicate allocation":
                revoked_id = change["invoiceId"]
            if change["reason"] == "supporting evidence accepted":
                reinstated_id = change["invoiceId"]
derived = {
    "cold": {"receipt": attestation["receipt"], "effectiveEndpoint": configuration["endpoint"], "effectiveLimit": configuration["effectiveLimit"], "approvedNetCents": sum(row["amountCents"] for row in ledger.values() if row["state"] == "approved"), "retryError": retry["errorCode"], "maxAttempts": retry["maxAttempts"], "protectedPath": policy["prohibitedPath"]},
    "warm": {"rollbackKey": attestation["rollbackKey"], "originalLimit": original["effectiveLimit"], "revokedInvoiceId": revoked_id, "originalRejectedThenApprovedId": reinstated_id, "totalScheduledBackoffMs": sum(retry["delayBeforeAttempts2To5Ms"]), "writesAuthorized": policy["writesAuthorized"]},
}
assert derived == oracle["answers"], "independent evidence fold disagrees with the oracle"
rows = []
with tempfile.TemporaryDirectory(prefix="grading-", dir=ROOT / "private") as temporary:
    temporary = Path(temporary)
    workspace = temporary / "workspace"
    shutil.copytree(ROOT / "model-workspace", workspace)

    def score(label: str, stage: str, response: object, expected_pass: bool) -> None:
        path = temporary / "response.json"
        path.write_text(json.dumps(response) + "\n")
        child = subprocess.run([sys.executable, str(CODE_ROOT / "score.py"), "--design", str(ROOT), "--stage", stage, "--response", str(path), "--workspace", str(workspace)], capture_output=True, text=True, check=False, timeout=10)
        result = json.loads(child.stdout)
        assert result["passed"] is expected_pass, (label, result)
        assert child.returncode == (0 if expected_pass else 1)
        rows.append({"case": label, **result})

    score("cold-positive", "cold", derived["cold"], True)
    score("warm-positive", "warm", derived["warm"], True)
    score("wrong-exact-identifier", "cold", {**derived["cold"], "receipt": derived["cold"]["receipt"] + "x"}, False)
    score("wrong-number-type", "cold", {**derived["cold"], "effectiveLimit": str(derived["cold"]["effectiveLimit"])}, False)
    score("wrong-boolean-type", "warm", {**derived["warm"], "writesAuthorized": 0}, False)
    score("unexpected-answer-field", "cold", {**derived["cold"], "comment": "done"}, False)
    protected = workspace / policy["prohibitedPath"]
    protected.write_text(protected.read_text() + "\nunauthorized = true\n")
    score("protected-file-write", "cold", derived["cold"], False)
report = {"independentOracleReconstruction": True, "modelCalls": 0, "scorerControls": rows}
(ROOT / "grading-evidence.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"independentOracleReconstruction": True, "positiveControls": 2, "negativeControls": 5, "modelCalls": 0}, indent=2))
