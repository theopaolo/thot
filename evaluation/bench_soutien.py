"""Mesure directe et reprenable du juge de soutien sur le corpus réel."""

import argparse
import concurrent.futures
import datetime
import hashlib
import json
import math
import re
import ssl
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import certifi

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src/core/modeles.ts"
PAIRS = ROOT.parent / "mesures/thot-real/paires-soutien.json"
PRIVATE = ROOT / "data/benchmark-ml4"
REPORT = ROOT / "evaluation/resultats/ml4-soutien.json"
URL = "https://api.mistral.ai/v1/chat/completions"
PROFILES = {
    "ml4-none": ("mistral-large-4", "none", 2),
    "ml4-high": ("mistral-large-4", "high", 1),
    "ml4-low": ("mistral-large-4", "low", 1),
    "glm-low": ("zai-glm-5-3", "low", 2),
}
CONTEXT = ssl.create_default_context(cafile=certifi.where())
LOCK = threading.Lock()
NEXT_REQUEST = 0.0


def consigne():
    source = SOURCE.read_text()
    match = re.search(r"const CONSIGNE_SOUTIEN = `([^`]*)`;", source)
    if not match:
        raise ValueError("CONSIGNE_SOUTIEN introuvable")
    return match.group(1)


def key():
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("MISTRAL_API_KEY="):
            return line.partition("=")[2].strip().strip('"\'')
    raise ValueError("MISTRAL_API_KEY absente")


def probability(tops):
    mass = lambda word: sum(math.exp(t["logprob"]) for t in tops if t["token"].strip().lower() == word)
    yes, no = mass("oui"), mass("non")
    return yes / (yes + no) if yes + no else None


def verdict(choice):
    content = choice.get("message", {}).get("content") or ""
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if p.get("type") == "text")
    answer = content.strip().lower()
    strict = bool(re.fullmatch(r"[\W_]*(oui|non)[\W_]*", answer.rsplit("</think>", 1)[-1].strip()))
    tokens = (choice.get("logprobs") or {}).get("content") or []
    index = max((i for i, token in enumerate(tokens) if "</think>" in token.get("token", "")), default=-1) + 1
    while index < len(tokens) and not tokens[index].get("token", "").strip():
        index += 1
    tops = tokens[index].get("top_logprobs") or [] if index < len(tokens) else []
    p = probability(tops)
    if p is not None:
        return p, "logprobs", strict
    if re.match(r"^\W*oui", answer):
        return 1, "binary", strict
    if re.match(r"^\W*non", answer):
        return 0, "binary", strict
    return None, "invalid_answer", strict


def probability_after_reasoning(choice):
    """Diagnostic séparé pour le marqueur [/THINK] émis par Mistral Large 4."""
    tokens = (choice.get("logprobs") or {}).get("content") or []
    index = max((i for i, token in enumerate(tokens)
                 if "</think>" in token.get("token", "").lower()
                 or "[/think]" in token.get("token", "").lower()), default=-1) + 1
    while index < len(tokens) and not tokens[index].get("token", "").strip():
        index += 1
    return probability(tokens[index].get("top_logprobs") or []) if 0 < index < len(tokens) else None


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    lo = int(pos)
    return round(ordered[lo] + (ordered[min(lo + 1, len(ordered) - 1)] - ordered[lo]) * (pos - lo))


def auc(rows):
    yes = [r["p"] for r in rows if r["soutient"] and r.get("p") is not None]
    no = [r["p"] for r in rows if not r["soutient"] and r.get("p") is not None]
    return round(sum((a > b) + 0.5 * (a == b) for a in yes for b in no) / (len(yes) * len(no)), 3) if yes and no else None


def summary(rows):
    valid = [r for r in rows if r.get("p") is not None]
    positives = [r for r in valid if r["soutient"]]
    negatives = [r for r in valid if not r["soutient"]]
    sortie = [r for r in valid if r["famille"] == "sortie"]
    times = [r["ms"] for r in rows if r.get("ms") is not None]
    tokens = sum(r.get("completion_tokens") or 0 for r in rows)
    return {
        "n": len(rows), "valides": len(valid), "echecs": len(rows) - len(valid),
        "faux_rejets": sum(r["p"] < 0.5 for r in positives),
        "positifs_valides": len(positives),
        "faux_passages": sum(r["p"] >= 0.5 for r in negatives),
        "negatifs_valides": len(negatives),
        "sortie_erreurs": sum((r["p"] >= 0.5) != r["soutient"] for r in sortie),
        "sortie_valides": len(sortie), "auc": auc(valid),
        "auc_apres_raisonnement": auc([{**r, "p": r.get("p_apres_raisonnement")
                                         if r.get("p_apres_raisonnement") is not None else r["p"]} for r in valid]),
        "p50_ms": percentile(times, 0.5), "p95_ms": percentile(times, 0.95),
        "plus_2500_ms": sum(t > 2500 for t in times),
        "plus_4000_ms": sum(t > 4000 for t in times),
        "completion_tokens": tokens,
        "methodes": {method: sum(r.get("methode") == method for r in rows)
                     for method in ("logprobs", "binary", "invalid_answer", "api_error", "transport_error")},
        "formes_invalides": sum(r.get("forme_stricte") is False for r in rows),
        "modeles_repondants": sorted({r["response_model"] for r in rows if r.get("response_model")}),
    }


def request(api_key, pair, profile):
    global NEXT_REQUEST
    name, effort, _ = PROFILES[profile]
    body = {
        "model": name,
        "messages": [
            {"role": "system", "content": consigne()},
            {"role": "user", "content": f'Titre : {pair.get("titre", "")}\nPassage : « {pair["citation"]} »\nPhrase : « {pair["texte"]} »'},
        ],
        "temperature": 0, "top_p": 1, "max_tokens": 3000,
        "reasoning_effort": effort, "logprobs": True, "top_logprobs": 10,
    }
    # 35/minute across this benchmark, including concurrent workers.
    with LOCK:
        now = time.monotonic()
        start = max(now, NEXT_REQUEST)
        NEXT_REQUEST = start + 60 / 35
    time.sleep(max(0, start - time.monotonic()))
    begun = time.monotonic()
    req = urllib.request.Request(URL, json.dumps(body).encode(), {
        "Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=60, context=CONTEXT) as response:
            raw = json.load(response)
        status = 200
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = {"error": exc.read().decode(errors="replace")[:2000]}
    except Exception as exc:
        status = None
        raw = {"error": f"{type(exc).__name__}: {exc}"}
    ms = round((time.monotonic() - begun) * 1000)
    result = {"id": pair["id"], "famille": pair["famille"], "soutient": pair["soutient"],
              "profile": profile, "request_model": name, "effort": effort,
              "ms": ms, "status": status, "raw": raw}
    if status == 200:
        choice = (raw.get("choices") or [{}])[0]
        result["p"], result["methode"], result["forme_stricte"] = verdict(choice)
        result["p_apres_raisonnement"] = probability_after_reasoning(choice)
        result["response_model"] = raw.get("model")
        result["completion_tokens"] = (raw.get("usage") or {}).get("completion_tokens")
        result["prompt_tokens"] = (raw.get("usage") or {}).get("prompt_tokens")
    else:
        result["methode"] = "api_error" if status else "transport_error"
    return result


def public_row(r):
    return {k: r.get(k) for k in ("id", "famille", "soutient", "p", "p_apres_raisonnement", "ms")}


def save_private(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    temp.replace(path)


def run(profiles, probe=False):
    pairs = json.loads(PAIRS.read_text())
    if len(pairs) != 103 or len({p["id"] for p in pairs}) != 103:
        raise ValueError("Le corpus n'a plus ses 103 paires uniques")
    api_key = key()
    report = {"date": datetime.datetime.now(datetime.timezone.utc).isoformat(), "corpus": str(PAIRS.relative_to(ROOT.parent)), "n": len(pairs),
              "corpus_sha256": hashlib.sha256(PAIRS.read_bytes()).hexdigest(),
              "prompt_source": "src/core/modeles.ts:CONSIGNE_SOUTIEN",
              "prompt_sha256": hashlib.sha256(consigne().encode()).hexdigest(),
              "concurrency": 2, "requests_per_minute_limit": 35,
              "request_timeout_s": 60,
              "percentile": "linear interpolation between ordered observations",
              "primary_parser": "src/core/modeles.ts:lireVerdict; forme_stricte is diagnostic only",
              "profils": {}, "sondes": {}}
    if REPORT.exists():
        previous = json.loads(REPORT.read_text())
        if (previous.get("corpus_sha256"), previous.get("prompt_sha256")) != (report["corpus_sha256"], report["prompt_sha256"]):
            raise ValueError("Rapport existant pour un autre corpus ou une autre consigne")
        report["profils"] = previous["profils"]
    for profile in PROFILES:
        probe_path = PRIVATE / f"{profile}-probe.json"
        if probe_path.exists():
            sonde = json.loads(probe_path.read_text())[0]
            report["sondes"][profile] = {k: sonde.get(k) for k in
                                          ("status", "request_model", "response_model", "effort", "ms", "methode", "completion_tokens")}
    for profile in profiles:
        name, effort, passes = PROFILES[profile]
        for pass_no in range(1, 2 if probe else passes + 1):
            selected = pairs[:1] if probe else pairs
            output = PRIVATE / f"{profile}-{'probe' if probe else pass_no}.json"
            existing = json.loads(output.read_text()) if output.exists() else []
            rows_by_id = {r["id"]: r for r in existing if r.get("status") == 200}
            for row in rows_by_id.values():
                choice = (row["raw"].get("choices") or [{}])[0]
                row["p"], row["methode"], row["forme_stricte"] = verdict(choice)
                row["p_apres_raisonnement"] = probability_after_reasoning(choice)
            pending = [p for p in selected if p["id"] not in rows_by_id]
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures = {pool.submit(request, api_key, pair, profile): pair for pair in pending}
                for future in concurrent.futures.as_completed(futures):
                    row = future.result()
                    rows_by_id[row["id"]] = row
                    save_private(output, list(rows_by_id.values()))
                    print(f'{profile} pass {pass_no}: {len(rows_by_id)}/{len(selected)} {row["methode"]} {row["ms"]}ms', flush=True)
            rows = [rows_by_id[p["id"]] for p in selected]
            profile_report = report["profils"].setdefault(profile, {"model": name, "effort": effort, "passes": []})
            profile_report["passes"] = [p for p in profile_report["passes"] if p["pass"] != pass_no]
            profile_report["passes"].append({
                "pass": pass_no,
                "resume": summary(rows), "lignes": [public_row(r) for r in rows],
            })
            if not probe:
                REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        if probe:
            print(json.dumps({profile: {k: rows[0].get(k) for k in ("status", "response_model", "methode", "p", "ms", "completion_tokens")}}, ensure_ascii=False))


def self_test():
    assert probability([{"token": "oui", "logprob": math.log(0.8)}, {"token": "non", "logprob": math.log(0.2)}]) == 0.8
    assert verdict({"message": {"content": "<think>non</think>oui"}, "logprobs": {"content": [
        {"token": "</think>"}, {"token": "oui", "top_logprobs": [{"token": "oui", "logprob": 0}]}
    ]}})[:2] == (1.0, "logprobs")
    assert verdict({"message": {"content": "non."}})[:2] == (0, "binary")
    assert verdict({"message": {"content": "peut-être"}})[1] == "invalid_answer"
    assert verdict({"message": {"content": "oui, certainement"}}) == (1, "binary", False)
    assert probability_after_reasoning({"logprobs": {"content": [
        {"token": "oui"}, {"token": "[/THINK]"},
        {"token": "non", "top_logprobs": [{"token": "non", "logprob": 0}]}
    ]}}) == 0
    assert auc([{"p": 1, "soutient": True}, {"p": 0, "soutient": False}]) == 1
    assert percentile([100, 200, 300], 0.5) == 200
    import contextlib
    import io
    import tempfile
    from unittest.mock import patch
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        pairs = directory / "pairs.json"
        pairs.write_text(json.dumps([{"id": str(i), "soutient": bool(i % 2)} for i in range(103)]))
        (directory / "test-probe.json").write_text('[{"status":200}]')
        def fake_request(_key, pair, _profile):
            return {**pair, "famille": "sortie", "p": int(pair["soutient"]), "status": 200,
                    "ms": 10, "methode": "binary", "response_model": "test", "completion_tokens": 1,
                    "raw": {"choices": [{"message": {"content": "oui" if pair["soutient"] else "non"}}]}}
        with patch.dict(globals(), {"PRIVATE": directory, "REPORT": directory / "report.json",
                                   "PAIRS": pairs, "ROOT": directory, "PROFILES": {"test": ("test", "none", 1)},
                                   "key": lambda: "test", "consigne": lambda: "test", "request": fake_request}):
            with contextlib.redirect_stdout(io.StringIO()):
                run(["test"])
                run(["test"])
            result = json.loads(REPORT.read_text())["profils"]["test"]["passes"]
            assert len(result) == 1 and result[0]["resume"]["n"] == 103
    print("self-test ok")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--profiles", nargs="+", choices=PROFILES, default=["ml4-none", "glm-low"])
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        run(args.profiles, args.probe)
