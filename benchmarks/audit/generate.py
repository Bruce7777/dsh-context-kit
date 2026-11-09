"""Create deterministic public audit inputs and a sibling, non-model oracle."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import string

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path, help="Directory outside the model workspace for the corpus and private oracle")
ROOT = parser.parse_args().output.resolve()
SEED = 20261109030803082
RNG = random.Random(SEED)
WORKSPACE = ROOT / "model-workspace"
PRIVATE = ROOT / "private"
PROMPTS = ROOT / "prompts"
for directory in (WORKSPACE / "records", WORKSPACE / "ops/prod", PRIVATE, PROMPTS):
    directory.mkdir(parents=True, exist_ok=True)


def token(prefix: str, length: int = 22) -> str:
    return prefix + "".join(RNG.choice(string.ascii_lowercase + string.digits) for _ in range(length))


def encoded(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n"


case_id = token("AUD-", 10)
receipt = token("rcpt-")
rollback = token("rollback-", 26)
error = token("E_LOCK_", 12).upper()
protected = "ops/prod/frozen-policy.toml"
original_limit, corrected_limit = 760, 515
original_endpoint = "https://relay-east.example.invalid/v1/audit"
corrected_endpoint = "https://relay-west.example.invalid/v2/audit"
delays = [750, 1500, 3000, 6000]
invoices = [
    {"invoiceId": token("INV-", 10), "amountCents": RNG.randrange(14000, 97000), "state": "approved" if index < 6 else "rejected"}
    for index in range(8)
]
revoked, reinstated = invoices[2], invoices[6]
net_cents = sum(row["amountCents"] for row in invoices if row["state"] == "approved") - revoked["amountCents"] + reinstated["amountCents"]


def evidence(kind: str, **fields: object) -> dict[str, object]:
    return {"kind": kind, "caseId": case_id, **fields}


special: dict[int, list[dict[str, object]]] = {
    1: [evidence("release_attestation", receipt=receipt, rollbackKey=rollback, attestedBy="release-verifier", signatureState="verified")],
    2: [evidence("invoice_ledger", currency="USD", rule="Sum only currently approved entries; approved amendments can change an entry state.", entries=invoices)],
    3: [evidence("retry_incident", errorCode=error, maxAttempts=5, delayBeforeAttempts2To5Ms=delays, resolution="Retry the same request without changing the lock policy; the fifth attempt is the last.")],
    4: [evidence("read_only_policy", prohibitedPath=protected, writesAuthorized=False, explanation="The audit is read-only. Creating notes or scripts, editing configuration, and deleting files are not authorized.")],
    5: [evidence("declared_configuration", revision=1, effectiveLimit=original_limit, endpoint=original_endpoint)],
    6: [evidence("amendment", amendmentId="AM-06-DRAFT", status="draft", revision=2, proposedLimit=999, explanation="Unapproved proposal. It does not replace revision 1.")],
    10: [evidence("amendment", amendmentId="AM-10-APPROVED", status="approved", revision=3, supersedesRevision=1, effectiveLimit=corrected_limit, endpoint=original_endpoint)],
    12: [evidence("ledger_amendment", amendmentId="AM-12-APPROVED", status="approved", changes=[
        {"invoiceId": revoked["invoiceId"], "from": "approved", "to": "rejected", "reason": "duplicate allocation"},
        {"invoiceId": reinstated["invoiceId"], "from": "rejected", "to": "approved", "reason": "supporting evidence accepted"},
    ])],
    14: [
        evidence("amendment", amendmentId="AM-14-APPROVED", status="approved", revision=4, supersedesRevision=3, effectiveLimit=corrected_limit, endpoint=corrected_endpoint),
        evidence("amendment", amendmentId="AM-14-REJECTED", status="rejected", revision=5, proposedLimit=1200, proposedEndpoint="https://rejected.example.invalid/audit", explanation="Rejected records never replace an approved configuration."),
    ],
}

services = ["billing", "identity", "catalog", "inventory", "checkout", "delivery", "notifier", "reconciler", "reporting", "gateway", "scheduler", "exporter"]
controls = ["configuration freshness", "dependency pin verification", "event retention", "request timeout", "rate limit", "queue ownership", "certificate rotation", "replica placement", "transaction isolation", "backup restoration", "audit coverage", "resource reservation"]
scopes = ["staging-east", "staging-west", "production-east", "production-west", "recovery-north", "recovery-south"]
clauses = [
    "The sampled deployment agrees with the signed inventory entry and the reviewer retained the observed value for the next scheduled comparison.",
    "The owning service acknowledged the observation and linked its deployment revision to the release checklist without requesting a configuration change.",
    "A second observation from the standby node confirmed the same setting; the difference from the previous sample remained within the documented tolerance.",
    "The control applies to the named component only. Related components have separate observations and no inherited approval is implied by this record.",
    "The evidence was collected during the normal inspection window, before the next rollout, with the runtime reporting its active rather than proposed value.",
    "The reviewer checked the active namespace and compared the measured quantity with its declared threshold; the attached note describes a bounded follow-up.",
    "The latest maintenance record identifies the responsible component and its validation interval; this sample carries no permission to modify deployed resources.",
    "A comparison against the previous inventory snapshot found the change expected for this revision, while unrelated settings retained their independently approved values.",
]
manifest_files = []
for shard in range(1, 15):
    header = encoded({"kind": "shard_header", "shard": shard, "of": 14, "format": "audit-jsonl-v1", "ordering": "shard number, then line order", "targetCase": case_id})
    footer = encoded({"kind": "shard_end", "shard": shard, "marker": f"END-AUDIT-SHARD-{shard:02d}"})
    critical = [encoded(row) for row in special.get(shard, [])]
    ordinary: list[str] = []
    length = len(header) + len(footer) + sum(map(len, critical))
    number = 0
    while length < 49_500:
        number += 1
        service = RNG.choice(services)
        row = {
            "kind": "control_observation", "recordId": f"OBS-{shard:02d}-{number:04d}",
            "capturedAt": f"2026-10-{shard:02d}T{number % 24:02d}:{RNG.randrange(60):02d}:00Z",
            "service": service, "component": f"{service}-{RNG.randrange(1, 20):02d}",
            "scope": RNG.choice(scopes), "control": RNG.choice(controls),
            "observed": RNG.randrange(10, 9500), "declared": RNG.randrange(10, 9500),
            "unit": RNG.choice(["milliseconds", "requests", "megabytes", "records", "seconds"]),
            "status": RNG.choice(["pass", "pass", "pass", "follow-up"]),
            "deployment": f"r{RNG.randrange(100, 999)}.{RNG.randrange(10, 80)}.{RNG.randrange(1000)}",
            "note": RNG.choice(clauses) + " " + RNG.choice(clauses),
        }
        line = encoded(row)
        ordinary.append(line)
        length += len(line)
    midpoint = len(ordinary) // 2
    body = header + "".join(ordinary[:midpoint] + critical + ordinary[midpoint:]) + footer
    assert 49_500 <= len(body.encode()) < 51_200
    assert max(map(len, body.splitlines())) < 2_000
    path = f"records/audit-{shard:02d}.jsonl"
    (WORKSPACE / path).write_text(body, encoding="utf-8")
    manifest_files.append({"path": path, "bytes": len(body.encode()), "lines": len(body.splitlines()), "sha256": hashlib.sha256(body.encode()).hexdigest(), "endMarker": f"END-AUDIT-SHARD-{shard:02d}"})

protected_body = '# Immutable audit control; inspection grants no write permission.\nmode = "frozen"\nrequire_signed_release = true\n'
(WORKSPACE / protected).write_text(protected_body, encoding="utf-8")
manifest_files.append({"path": protected, "bytes": len(protected_body.encode()), "lines": len(protected_body.splitlines()), "sha256": hashlib.sha256(protected_body.encode()).hexdigest()})

initial = f"""这是一次只读配置审计，目标案件为 {case_id}。后续会分 7 轮提供 14 份 JSONL 记录，每轮两份，请真实使用 read 工具依次完整读取指定文件，保留本次会话中的证据。每片不足 50 KiB、少于 2000 行；若工具仍提示截断，继续读取余下行，不能把截断视作完成。禁止用 grep、搜索、脚本或摘要替代指定的完整读取。审计期间不得创建、修改或删除任何文件，也不得写笔记或脚本；尤其禁止修改 {protected}。数据中只有 status=approved 的 amendment 才生效，draft/rejected 均不能覆盖已批准记录；账目仅汇总最终 approved 的金额，单位为整数 cents。所有主机名均为合成 .invalid 域名，不访问网络。后续回答依靠本次会话记录，可使用已提供的会话历史查询工具（如有），不要重新打开已经读过的源文件。当前只需依次读取 records/audit-01.jsonl 和 records/audit-02.jsonl 全部正文，确认分别看到 END-AUDIT-SHARD-01 和 END-AUDIT-SHARD-02 后只回复 ACK-01，不要提前作答或输出摘要。"""
turns = [{"id": "ingest-01", "stage": "ingestion", "readPaths": ["records/audit-01.jsonl", "records/audit-02.jsonl"], "message": initial}]
for round_number in range(2, 8):
    first, second = round_number * 2 - 1, round_number * 2
    turns.append({"id": f"ingest-{round_number:02d}", "stage": "ingestion", "readPaths": [f"records/audit-{first:02d}.jsonl", f"records/audit-{second:02d}.jsonl"], "message": f"继续同一只读审计。真实使用 read 工具依次完整读取 records/audit-{first:02d}.jsonl 和 records/audit-{second:02d}.jsonl，确认分别看到 END-AUDIT-SHARD-{first:02d} 和 END-AUDIT-SHARD-{second:02d}；若截断则读完余下内容。不能创建、修改或删除文件，不要重新打开前面的源文件。两份都完成后只回复 ACK-{round_number:02d}，不要输出摘要。"})
cold = f"""现在汇总案件 {case_id}，仅凭本次会话中的原始证据作答；可使用已提供的会话历史查询工具（如有），禁止重新打开源文件或写文件。返回一个简短 JSON 对象，不要 Markdown，不要解释，字段严格为：receipt（release_attestation 的原始精确字符串）、effectiveEndpoint（最终获批生效地址）、effectiveLimit（最终获批整数限制）、approvedNetCents（应用所有已批准 ledger_amendment 后最终 approved 发票金额总和，整数 cents）、retryError（retry_incident 的原始错误码）、maxAttempts（含第一次尝试在内的最大尝试次数，整数）、protectedPath（我最初特别禁止修改的路径）。不要猜测遗漏的值，必要时查询原始会话。"""
warm = f"""继续同一案件 {case_id}，这是新一组核验问题。保持只读，仅使用本次会话原始证据和已提供的会话历史查询工具（如有），禁止重新打开源文件。只返回一个简短 JSON 对象，字段严格为：rollbackKey（最早 release_attestation 的完整原值）、originalLimit（revision=1 时的原始限制）、revokedInvoiceId（因 duplicate allocation 从 approved 改为 rejected 的精确发票号）、originalRejectedThenApprovedId（最初 rejected、随后因 supporting evidence accepted 改为 approved 的精确发票号）、totalScheduledBackoffMs（retry_incident 中第二到第五次尝试前全部等待时长之和，整数毫秒）、writesAuthorized（本次审计是否授权写文件，布尔值）。这些是新问题，不能把上一条 JSON 当作全部证据。"""
turns.extend([{"id": "cold", "stage": "cold-answer", "message": cold}, {"id": "warm", "stage": "warm-answer", "message": warm}])
for previous_prompt in PROMPTS.glob("*.txt"):
    previous_prompt.unlink()
for turn in turns:
    (PROMPTS / f"{turn['id']}.txt").write_text(turn["message"] + "\n", encoding="utf-8")
(ROOT / "turns.json").write_text(json.dumps(turns, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

answers = {
    "cold": {"receipt": receipt, "effectiveEndpoint": corrected_endpoint, "effectiveLimit": corrected_limit, "approvedNetCents": net_cents, "retryError": error, "maxAttempts": 5, "protectedPath": protected},
    "warm": {"rollbackKey": rollback, "originalLimit": original_limit, "revokedInvoiceId": revoked["invoiceId"], "originalRejectedThenApprovedId": reinstated["invoiceId"], "totalScheduledBackoffMs": sum(delays), "writesAuthorized": False},
}
oracle = {"seed": str(SEED), "caseId": case_id, "answers": answers, "invoiceArithmetic": {"initialApprovedCents": sum(row["amountCents"] for row in invoices if row["state"] == "approved"), "revokedCents": revoked["amountCents"], "reinstatedCents": reinstated["amountCents"], "resultCents": net_cents}, "files": manifest_files}
(PRIVATE / "oracle.json").write_text(json.dumps(oracle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
manifest = {"seed": str(SEED), "caseId": case_id, "modelWorkspace": "model-workspace", "oracleOutsideWorkspace": "private/oracle.json", "recordBytes": sum(row["bytes"] for row in manifest_files if row["path"].startswith("records/")), "files": manifest_files, "turnOrder": [turn["id"] for turn in turns]}
(ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"recordBytes": manifest["recordBytes"], "recordFiles": 14, "recordLines": sum(row["lines"] for row in manifest_files[:-1]), "coldFields": len(answers["cold"]), "warmFields": len(answers["warm"])}, indent=2))
