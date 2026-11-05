"""Score how well each quoted item of a logic model version is supported by its booklet quote.

Advisory only. The scores never become findings, never gate a signature and never touch the model.
They tell the reviewer which items to read first. Medic's rule 6 still holds: no model judges a test,
and expected outcomes come from the approved logic.

The judge is Strands Evals' OutputEvaluator (LLM-as-a-judge on Amazon Bedrock). Each item is judged
`--samples` times at a non-zero temperature. The item score is the mean of the samples; agreement is
the share of samples that agree with the majority pass/fail. An item is flagged when its score is below
`--threshold` or the samples disagree. A judge call that fails flags the item: nothing passes silently.

Items without a quote (origin "team" or "clinician" with no source) are listed as not scored.

Usage:
  python3 score_version.py --model ../tests/fixtures/logic/v1.json \
      --blocks ../extraction/input_blocks.json --out scores.json
Env: JUDGE_MODEL_ID (or --judge-model), AWS_REGION (default us-west-2).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

RUBRIC = """You are checking one item of a clinical decision form against the guideline text it cites.
The Input holds the cited quote(s), the full text of the cited page(s) when available, and context.
The Output is the item as the form will use it.

Score 1.0 when the quote (read with its page) states everything the item asserts: every number,
age band, condition, action, drug, dose and timing.
Score 0.5 when the quote supports the item only in part: the item adds, drops or broadens something,
or the quote covers only one of several things the item asserts.
Score 0.0 when the quote does not support the item, says something different, or belongs to another item.

Judge support only. Do not judge whether the clinical advice is good. Wording may differ when the
meaning is the same. Pass only at a score of 1.0."""

NOTICE = ("Advisory only: a model's opinion of whether each quote supports its item. It is not a check, "
          "never blocks a signature, and a high score does not mean the item is clinically right.")


@dataclass
class Item:
    path: str
    kind: str
    output: dict[str, Any]
    quotes: list[dict[str, Any]]
    context: dict[str, Any] = field(default_factory=dict)


def _sources(x: dict) -> list[dict]:
    s = x.get("source")
    if s is None:
        return []
    return s if isinstance(s, list) else [s]


def _strip(x: dict, *keys: str) -> dict:
    return {k: v for k, v in x.items() if k not in ("source", "origin", *keys)}


def collect_items(model: dict) -> tuple[list[Item], list[dict]]:
    """Every part of the model that cites the booklet, plus the parts that cite nothing (not scored)."""
    derived = {d["id"]: d.get("label") for d in model.get("derived", [])}
    questions = {q["id"]: q.get("label") for q in model.get("questions", [])}
    outcomes = {o["id"]: o.get("title") for o in model.get("outcomes", [])}
    items: list[Item] = []
    skipped: list[dict] = []

    def add(path: str, kind: str, obj: dict, output: dict, context: dict | None = None) -> None:
        q = _sources(obj)
        if q:
            items.append(Item(path, kind, output, q, context or {}))
        else:
            skipped.append({"item": path, "kind": kind, "why": f"no quote (origin {obj.get('origin', 'n/a')})"})

    if "scope" in model:
        add("scope", "scope", model["scope"], _strip(model["scope"], "excluded"))
    for q in model.get("questions", []):
        add(f"questions/{q['id']}", "question", q, _strip(q, "order"))
    for d in model.get("derived", []):
        add(f"derived/{d['id']}", "derived", d, _strip(d), {"fields": {**questions, **derived}})
    for o in model.get("outcomes", []):
        add(f"outcomes/{o['id']}", "outcome", o, _strip(o, "actions", "follow_up"))
        for i, a in enumerate(o.get("actions", [])):
            add(f"outcomes/{o['id']}/actions/{i}", "action", a, _strip(a), {"outcome": o.get("title")})
        if o.get("follow_up"):
            add(f"outcomes/{o['id']}/follow_up", "follow_up", o["follow_up"], _strip(o["follow_up"]),
                {"outcome": o.get("title")})
    for r in model.get("rules", []):
        ctx = {"result": outcomes.get(r.get("outcome")), "fields": {**questions, **derived}}
        add(f"rules/{r['id']}", "rule", r, _strip(r, "priority"), ctx)
    return items, skipped


def page_texts(blocks: dict | None) -> dict[int, str]:
    if not blocks:
        return {}
    return {p["pdf_page"]: "\n".join(b["text"] for b in p["blocks"]) for p in blocks.get("pages", [])}


def judge_input(item: Item, pages: dict[int, str]) -> str:
    cited = sorted({q["page"] for q in item.quotes})
    parts = [f"<Kind>{item.kind}</Kind>",
             "<Quotes>" + json.dumps(item.quotes, ensure_ascii=False) + "</Quotes>"]
    for p in cited:
        if p in pages:
            parts.append(f'<Page n="{p}">{pages[p]}</Page>')
    if item.context:
        parts.append("<Context>" + json.dumps(item.context, ensure_ascii=False) + "</Context>")
    return "\n".join(parts)


class JudgeUnavailable(RuntimeError):
    """Every judge call for the first item failed: nothing was scored."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("the judge could not be reached; first error: " + errors[0])


# A judge takes (input, output) and returns (score, test_pass, reason, usage).
Judge = Callable[[str, str], tuple[float, bool, str | None, dict[str, int]]]


def strands_judge(model_id: str, region: str, temperature: float) -> Judge:
    """OutputEvaluator from Strands Evals with a Bedrock judge. Imports are here so tests need no AWS."""
    from strands import Agent
    from strands.models import BedrockModel
    from strands_evals.evaluators import OutputEvaluator
    from strands_evals.types.evaluation import EvaluationData, EvaluationOutput

    # streaming=False: the judge answers through a tool call, and Bedrock does not support tool use while
    # streaming for some models (Meta Llama, for one). The judge does not need streaming.
    # Claude Haiku 5.5 rejects any temperature but its default (ERR-012; same rule as Backend/src/model/strands.ts).
    # Its default is not zero, so the samples still vary. Every other model gets the requested temperature.
    temp = {} if "claude-haiku-5" in model_id else {"temperature": temperature}
    bedrock = BedrockModel(model_id=model_id, region_name=region, max_tokens=1024, streaming=False, **temp)

    class QuoteSupportEvaluator(OutputEvaluator):
        """OutputEvaluator.evaluate, keeping the judge's token usage for the cost record."""

        def evaluate_with_usage(self, case):
            agent = Agent(model=self.model, tools=self.tools, system_prompt=self.system_prompt, callback_handler=None)
            res = agent(self._build_prompt(case), structured_output_model=EvaluationOutput)
            u = res.metrics.accumulated_usage
            return res.structured_output, {"inputTokens": int(u.get("inputTokens", 0)), "outputTokens": int(u.get("outputTokens", 0))}

    ev = QuoteSupportEvaluator(rubric=RUBRIC, model=bedrock, include_inputs=True)

    def judge(inp: str, out: str):
        o, usage = ev.evaluate_with_usage(EvaluationData(input=inp, actual_output=out))
        return float(o.score), bool(o.test_pass), o.reason, usage

    return judge


def score_item(item: Item, pages: dict[int, str], judge: Judge, samples: int, threshold: float, retries: int = 1) -> dict:
    inp = judge_input(item, pages)
    out = json.dumps(item.output, ensure_ascii=False)
    runs, errors, usage = [], [], {"inputTokens": 0, "outputTokens": 0}
    for _ in range(samples):
        for attempt in range(retries + 1):
            try:
                score, ok, reason, u = judge(inp, out)
                score = min(1.0, max(0.0, float(score)))
                runs.append({"score": score, "pass": bool(ok) and score >= 1.0, "reason": reason})
                usage["inputTokens"] += u.get("inputTokens", 0)
                usage["outputTokens"] += u.get("outputTokens", 0)
                break
            except Exception as e:  # noqa: BLE001 - any judge failure must flag, never pass
                if attempt == retries:
                    errors.append(f"{type(e).__name__}: {e}"[:300])
                else:
                    time.sleep(1.0)
    res: dict[str, Any] = {"item": item.path, "kind": item.kind, "pages": sorted({q["page"] for q in item.quotes}),
                           "quotes": [q["quote"] for q in item.quotes], "samples": runs, "usage": usage}
    if not runs:
        res.update(score=None, agreement=None, flag=True, why="the judge could not be reached", errors=errors)
        return res
    mean = sum(r["score"] for r in runs) / len(runs)
    passes = sum(1 for r in runs if r["pass"])
    agreement = max(passes, len(runs) - passes) / len(runs)
    why = []
    if mean < threshold:
        why.append(f"score {mean:.2f} is below {threshold}")
    if agreement < 1.0:
        why.append(f"the judge disagreed with itself ({passes} of {len(runs)} passed)")
    if errors:
        why.append(f"{len(errors)} of {samples} judge calls failed")
    low = min(runs, key=lambda r: r["score"])
    res.update(score=round(mean, 3), agreement=round(agreement, 3), flag=bool(why), why="; ".join(why) or None,
               lowest_reason=low["reason"])
    if errors:
        res["errors"] = errors
    return res


def score_model(model: dict, blocks: dict | None, judge: Judge, samples: int = 3, threshold: float = 0.7,
                workers: int = 8, progress: bool = False) -> dict:
    items, skipped = collect_items(model)
    pages = page_texts(blocks)
    done = [0]

    def one(it: Item) -> dict:
        r = score_item(it, pages, judge, samples, threshold)
        if progress:
            done[0] += 1
            print(f"  {done[0]}/{len(items)} {it.path}: {r['score']}{'  FLAG' if r['flag'] else ''}",
                  file=sys.stderr, flush=True)
        return r

    if not items:
        scored = []
    else:
        # Fail fast: if the first item cannot be judged at all (no credentials, no model access, a model
        # that cannot return the answer), stop with the real error instead of flagging every item.
        first = one(items[0])
        if first["score"] is None:
            raise JudgeUnavailable(first.get("errors") or ["no error text"])
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            scored = [first] + list(pool.map(one, items[1:]))
    # Flagged first, lowest score first: the order the reviewer should read them in.
    scored.sort(key=lambda r: (not r["flag"], r["score"] if r["score"] is not None else -1, r["item"]))
    total = {"inputTokens": sum(r["usage"]["inputTokens"] for r in scored),
             "outputTokens": sum(r["usage"]["outputTokens"] for r in scored)}
    flagged = sum(1 for r in scored if r["flag"])
    return {
        "notice": NOTICE,
        "summary": {"scored": len(scored), "flagged": flagged, "not_scored": len(skipped),
                    "to_read_closely": flagged, "to_glance_at": len(scored) - flagged},
        "items": scored,
        "not_scored": skipped,
        "usage": total,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="logic model version JSON")
    ap.add_argument("--blocks", help="input_blocks.json of the run (page text for the judge)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--judge-model", default=os.environ.get("JUDGE_MODEL_ID"),
                    help="Bedrock model or us. inference profile ID; pick one other than the drafting model")
    ap.add_argument("--region", default=os.environ.get("AWS_REGION", "us-west-2"))
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--temperature", type=float, default=0.5)
    ap.add_argument("--threshold", type=float, default=0.7)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args(argv)
    if not a.judge_model:
        ap.error("set --judge-model or JUDGE_MODEL_ID")

    model_bytes = Path(a.model).read_bytes()
    model = json.loads(model_bytes)
    blocks = json.loads(Path(a.blocks).read_text()) if a.blocks else None
    started = time.time()
    print(f"scoring with {a.judge_model}...", file=sys.stderr, flush=True)
    try:
        result = score_model(model, blocks, strands_judge(a.judge_model, a.region, a.temperature),
                             a.samples, a.threshold, a.workers, progress=True)
    except JudgeUnavailable as e:
        print(f"STOPPED: nothing was scored. The judge ({a.judge_model}) failed on the first item:", file=sys.stderr)
        for err in dict.fromkeys(e.errors):
            print(f"  {err}", file=sys.stderr)
        return 2
    result["run"] = {
        "judge": "strands_evals.OutputEvaluator", "judge_model": a.judge_model, "region": a.region,
        "samples": a.samples, "temperature": a.temperature, "threshold": a.threshold,
        "model_file_sha256": hashlib.sha256(model_bytes).hexdigest(),
        "pathway": model.get("meta", {}).get("pathway_id"), "version": model.get("meta", {}).get("version"),
        "seconds": round(time.time() - started, 1),
    }
    Path(a.out).write_text(json.dumps(result, indent=2, ensure_ascii=False))
    s = result["summary"]
    print(f"scored {s['scored']}  flagged {s['flagged']}  not scored {s['not_scored']}  "
          f"tokens in {result['usage']['inputTokens']} out {result['usage']['outputTokens']}  "
          f"{result['run']['seconds']}s")
    for r in result["items"]:
        if r["flag"]:
            print(f"  FLAG {r['item']}: {r['why']}")
    print(f"written: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
