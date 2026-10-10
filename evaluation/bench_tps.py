"""Mesure le débit des générations déjà journalisées, sans nouvel appel de modèle.

OpenRouter: https://openrouter.ai/docs/api/api-reference/generations/get-generation
Exécution : python3 evaluation/bench_tps.py [--self-test]
"""

import datetime
import json
import math
import os
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "data/benchmark-ml4"
REPORT = ROOT / "evaluation/resultats/ml4-throughput.json"
CACHE = PRIVATE / "metadata.json"
MODELS = {
    "deepseek/deepseek-v4.1-flash",
    "mistralai/mistral-large-4-0",
    "openai/gpt-oss-120b",
    "google/gemma-4-26b-a4b-it",
}
SAMPLE = 12


def api_key():
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith("OPENROUTER_API_KEY="):
                key = line.partition("=")[2].strip().strip("\"'")
                break
    if not key:
        raise ValueError("OPENROUTER_API_KEY absente")
    return key


def candidates():
    groups = defaultdict(dict)
    invalid_rows = 0
    for path in sorted(PRIVATE.glob("*-calls.jsonl")):
        variant = path.name.removesuffix("-calls.jsonl")
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
                model = row.get("body", {}).get("model")
                response = row.get("response", {})
                ident = response.get("id")
                if (row.get("status") == 200 and model in MODELS and
                        isinstance(ident, str) and ident.startswith("gen-") and
                        response.get("provider")):
                    groups[(variant, model)][ident] = {
                        "id": ident,
                        "provider": response["provider"],
                        "client_ms": row.get("ms"),
                        "effort": (row["body"].get("reasoning") or {}).get("effort"),
                    }
            except (ValueError, TypeError, AttributeError):
                invalid_rows += 1
    return {key: list(rows.values()) for key, rows in groups.items()}, invalid_rows


def sample(rows, size=SAMPLE):
    if len(rows) <= size:
        return rows
    return [rows[i * (len(rows) - 1) // (size - 1)] for i in range(size)]


def metadata(ident, key, context):
    url = "https://openrouter.ai/api/v1/generation?" + urllib.parse.urlencode({"id": ident})
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=20, context=context) as response:
                data = json.load(response)["data"]
            if not isinstance(data, dict) or data.get("id") != ident:
                raise ValueError("identifiant incohérent")
            fields = ("id", "model", "provider_name", "generation_time", "latency",
                      "native_tokens_completion", "native_tokens_reasoning", "total_cost")
            return {field: data.get(field) for field in fields}
        except urllib.error.HTTPError as error:
            if error.code not in (404, 429, 500, 502, 503, 504) or attempt == 2:
                raise ValueError(f"HTTP {error.code}") from None
        except urllib.error.URLError as error:
            if attempt == 2:
                raise ValueError(f"réseau: {error.reason.__class__.__name__}") from None
        if attempt < 2:
            time.sleep(2 ** attempt)
    raise AssertionError("boucle de requête incomplète")


def positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def median(values):
    return round(statistics.median(values), 1) if values else None


def summarize(rows):
    generation_tps, request_tps, latency, client, reasoning = [], [], [], [], []
    providers, failures = Counter(), Counter()
    cost = 0.0
    inconsistent_tokens = 0
    for row in rows:
        data = row.get("metadata")
        if data is None:
            failures[row.get("error", "métadonnées absentes")] += 1
            continue
        providers[data.get("provider_name") or row["provider"]] += 1
        tokens = data.get("native_tokens_completion")
        duration = data.get("generation_time")
        if positive(tokens) and positive(duration):
            generation_tps.append(tokens * 1000 / duration)
        else:
            failures["débit natif indisponible"] += 1
        if positive(tokens) and positive(row.get("client_ms")):
            request_tps.append(tokens * 1000 / row["client_ms"])
        if positive(data.get("latency")):
            latency.append(data["latency"])
        if positive(row.get("client_ms")):
            client.append(row["client_ms"])
        if isinstance(data.get("native_tokens_reasoning"), (int, float)):
            reasoning.append(data["native_tokens_reasoning"])
            if positive(tokens) and data["native_tokens_reasoning"] > tokens:
                inconsistent_tokens += 1
        if isinstance(data.get("total_cost"), (int, float)):
            cost += data["total_cost"]
    return {
        "sampled": len(rows),
        "metadata_ok": sum(1 for row in rows if row.get("metadata") is not None),
        "generation_tps_n": len(generation_tps),
        "generation_tps_median": median(generation_tps),
        "effective_request_tps_n": len(request_tps),
        "effective_request_tps_median": median(request_tps),
        "provider_latency_ms_median": median(latency),
        "client_request_ms_median": median(client),
        "reasoning_tokens_median": median(reasoning),
        "reasoning_exceeds_completion": inconsistent_tokens,
        "sample_total_cost_usd": round(cost, 6),
        "providers": dict(providers),
        "metadata_failures": dict(failures),
    }


def self_test():
    assert sample(list(range(35))) == [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 34]
    rows = [{"provider": "P", "client_ms": 2000,
             "metadata": {"provider_name": "P", "native_tokens_completion": 100,
                          "generation_time": 1000, "latency": 1500,
                          "native_tokens_reasoning": 110, "total_cost": 0.01}},
            {"provider": "P", "client_ms": 1000, "error": "HTTP 404"}]
    result = summarize(rows)
    assert (result["generation_tps_median"], result["effective_request_tps_median"],
            result["metadata_failures"], result["reasoning_exceeds_completion"]) == (
                100, 50, {"HTTP 404": 1}, 1)
    print("bench_tps self-test OK")


def main():
    groups, invalid = candidates()
    if not groups:
        raise ValueError("Aucun appel de génération OpenRouter réussi dans les journaux")
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    key = api_key() if any(row["id"] not in cache for rows in groups.values()
                       for row in sample(rows)) else None
    try:
        import certifi
        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        context = ssl.create_default_context()
    results = []
    for (variant, model), all_rows in sorted(groups.items()):
        selected = sample(all_rows)
        for row in selected:
            if row["id"] not in cache:
                try:
                    cache[row["id"]] = metadata(row["id"], key, context)
                    CACHE.write_text(json.dumps(cache, indent=1))
                except (ValueError, TimeoutError, KeyError, OSError) as error:
                    row["error"] = str(error)[:100]
            row["metadata"] = cache.get(row["id"])
        efforts = sorted({row["effort"] for row in selected if row["effort"] is not None})
        results.append({"variant": variant, "model": model,
                        "effort": efforts[0] if len(efforts) == 1 else efforts,
                        "eligible": len(all_rows),
                        **summarize(selected)})
    report = {
        "date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": "https://openrouter.ai/docs/api/api-reference/generations/get-generation",
        "definition": {
            "generation_tps": "native_tokens_completion / (generation_time en secondes), médiane des ratios individuels",
            "effective_request_tps": "native_tokens_completion / (durée de requête client en secondes), médiane des ratios individuels",
            "provider_latency": "latency déclarée par OpenRouter, en ms ; le client non streamé ne mesure pas le premier token",
            "sampling": "au plus 12 appels réussis par variante et modèle, espacés régulièrement dans l'ordre du journal",
            "tokens": "comptes natifs déclarés par OpenRouter ; le raisonnement est indiqué séparément et peut dépasser le compte de complétion",
        },
        "invalid_log_rows": invalid,
        "results": results,
    }
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    for row in results:
        print(f"{row['variant']}: {row['metadata_ok']}/{row['sampled']} métadonnées, "
              f"génération {row['generation_tps_median']} tok/s, "
              f"requête {row['effective_request_tps_median']} tok/s")
    print(REPORT.relative_to(ROOT))


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    elif sys.argv[1:]:
        raise SystemExit("usage: python3 evaluation/bench_tps.py [--self-test]")
    else:
        main()
