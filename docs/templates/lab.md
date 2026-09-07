# lab template

A lab bench for comparing the quality, cost, tokens, and latency of 2–6 experiment arms. Use it for context-management experiments, prompt changes, retrieval strategies, or model comparisons. It renders records from your evaluation harness; it does not call models, run tools, or infer a winner.

## TL;DR

- One board contains the configurations, aggregate ledger, case checks, outputs, and individual provider requests.
- A generation event that sums several requests is a run total, not a context size. Supply individual request records, including failed attempts.
- Missing accounting stays unknown. Pending runs, missing repetitions, and unresolved checks block cost-per-correct comparisons.
- Every quality verdict needs evidence. Reviewers can annotate that evidence and vote once per case.
- The bundled example is synthetic. Copy its shape, not its invented performance numbers.

## Key files

| Path | Purpose |
| --- | --- |
| `templates/lab.js` | Validates the data, derives totals, and renders the bench |
| `test/samples/lab.json` | Complete example with passing, failing, pending, and interrupted runs |
| `test/lab.test.js` | Accounting, validation, and escaping tests |

## Usage patterns

From the Easel checkout, preview the synthetic example:

```sh
node test/preview.js lab test/samples/lab.json --out test/out/lab.html --theme dark
```

Publish a durable source, then collect review feedback:

```sh
mkdir -p ~/.easel/sources
cp test/samples/lab.json ~/.easel/sources/context-lab.json
easel open --template lab --data ~/.easel/sources/context-lab.json --title "Context optimization lab bench"
easel await <key> --agent my-workspace:lab
```

Your harness or agent writes records to that same source file after each batch. Republish manually when new results are ready:

```sh
easel publish <key> --note "Added paired repetitions and request usage" --agent my-workspace:lab
```

The source is local; publishing a board does not publish it to GitHub or the internet. Never put credentials or private evaluation data in the public sample.

## Input schema

```jsonc
{
  "title": "Context optimization lab bench",
  "summary": "Optional markdown explaining the question.",
  "manifest": {
    "dataset": "frozen-cases-v1",
    "date": "2026-09-07",
    "procedure": "Randomize arm order per case. Freeze retrieval responses.",
    "judge": "Exact checks plus reviewer",
    "evidence": "measured" // measured | synthetic | planned
  },
  "repetitions": 3, // planned repetitions for EVERY case/arm
  "baseline": "control", // an arm id, used for cost comparisons
  "arms": [
    {
      "id": "control", "name": "Control",
      "model": "your-model", "provider": "your-provider",
      "config": { "Context policy": "Full replay", "Reasoning": "medium" }
    },
    {
      "id": "compact", "name": "Compaction",
      "model": "your-model", "provider": "your-provider",
      "config": { "Context policy": "Automatic at 160k", "Reasoning": "medium" }
    }
  ],
  "cases": [{
    "id": "date-recall", "name": "Recall a corrected date",
    "prompt": "What is the delivery date?",
    "context": "Optional markdown: expected behavior and fixture provenance.",
    "criteria": ["Exact date", "Action restraint"],
    "runs": {
      "control": [{
        "id": "date-control-1", "repetition": 1,
        "status": "complete", // pending | running | complete | error
        "accounting": "complete", // complete | partial: have ALL attempts been captured?
        "latencyMs": 4800, // end-to-end completion latency, not summed request time
        "output": "The delivery date is October 12.", // optional markdown
        "checks": {
          "Exact date": { "status": "pass", "evidence": "Output matches the correction to October 12." },
          "Action restraint": { "status": "pass", "evidence": "No mutation appears in the complete tool trace." }
        },
        "requests": [{
          "id": "provider-request-id", "status": "complete", // complete | error
          "inputTokens": 62000,
          "cacheReadTokens": 40000, "cacheWriteTokens": 0,
          "outputTokens": 240, "reasoningTokens": 120,
          "costUsd": null, // unknown; supply costSource whenever costUsd is numeric
          "latencyMs": 3100,
          "compactions": 0 // provider-observed count; null if not observed
        }]
      }],
      "compact": [] // an explicit pending arm, not a missing object key
    }
  }]
}
```

`config` values are strings, numbers, or booleans describing what the harness actually ran. They are displayed documentation, not controls that change provider behavior. Use a new arm for a different model, provider, or material configuration. The dataset and procedure should identify the exact fixture revision, tool set, randomization, cache warm-up, and input date window needed to reproduce the run.

Run ids must be unique across the board. Request ids must be unique within their run. Repetition numbers pair observations across arms and must be unique within each case/arm, from 1 through `repetitions`. Every case must contain every arm; use an empty array for an arm that has not run. Planned boards can contain only pending runs without request records.

Every supplied run carries every criterion, with `pass`, `fail`, or `unknown` and a nonempty evidence explanation. Pending runs use unknown checks. An error run needs an `error` explanation. Missing metrics may be omitted or null; known zero stays zero. A completed run must have at least one provider request. A pre-request error can have none, but its cost remains unestablished.

## Accounting rules

Input includes cache reads and cache writes. Normalize provider fields before importing them: those two cache buckets must be disjoint and their sum cannot exceed input. Reasoning is a subset of output, never an additional charge. Compactions are observed events, not guesses based on a run's token sum.

Costs are USD amounts supplied by the harness. Each numeric `costUsd` needs `costSource`, such as a provider charge or a named price-sheet calculation and version. Easel does not guess rates from model names. Include compaction calls, retries, and allocated supporting calls in the request ledger. Allocate background work consistently between arms and document that rule in `manifest.procedure`.

The ledger counts a task as correct only when it completed and every criterion passed. Cost per correct task divides **all recorded spend**, including failed attempts and incorrect tasks, by correct tasks. It is withheld until every planned repetition is settled, every run has complete accounting, every request has a known cost, and every completed run has resolved checks. No correct tasks means the metric is not established, not free.

Aggregate totals with missing records show only the observed amount, marked incomplete. Completion p50/p95 use linear interpolation over completed runs with known end-to-end latency and display `n / planned`; request latency is shown separately. Errors are counted separately and excluded from these completion percentiles. Inspect error rate alongside latency so faster failures cannot look like faster answers.

## Gotchas

- Three 60k requests are 180k of run input, but none crossed a 160k boundary. Inspect the request ledger before claiming compaction eligibility or long-context pricing.
- Equal aggregate scores do not prove quality parity. The bench does not compute confidence intervals, establish causal attribution, or automatically recommend rollout. Use paired representative tasks, enough repetitions, and human review of regressions.
- A row marked `complete` means execution finished; it does not mean the answer passed. A cheap arm can fail its checks.
- `accounting: "complete"` is the harness's assertion that all attempts were collected. A missing cost remains unknown even with that assertion. Do not label an interrupted stream complete when final usage never arrived.
- Costs from different sources are not automatically comparable. Verify provider rates, cache buckets, auxiliary work, and currency before using the percentage delta.
- A template update affects future rounds only. Rebuild/restart the daemon using the normal development workflow before publishing with a newly installed template.
- `Tie`, `Neither`, and `Insufficient evidence` are reserved verdict labels and cannot be arm names. Votes arrive through Easel's existing widget feedback protocol as `lab-<case id>`.
