# Context policy experiment — September 7, 2026

## TL;DR

- 44 live runs compared chat-history policies, summarizers, and an OpenRouter route control. All source data was synthetic.
- Adding a local tool-result governor to stored summaries and pruning cut input 48.9%, normalized cost 48.5%, and observed mean completion time 6.6% in the large-tool scenario.
- Native compaction used direct Azure Responses. It never ran through OpenRouter. After the governor, native emitted zero compactions.
- Native compaction dropped an audit code in one of two summarizer runs. Plain Sol and Gemini retained that code on both fixtures.
- This supports a targeted governor rollout and keeping native compaction off by default. Two seeds per scenario do not establish production quality parity or p95.

## Key files

| File | Purpose |
| --- | --- |
| `lab.json` | Six chat-policy arms, full synthetic answers, checks, and request accounting |
| `summarizers.json` | Three summarizer arms with their complete synthetic summaries |
| `results.json` | Aggregate statistics and scope limitations |
| `../../templates/lab.md` | Lab template schema and rendering contract |

## Usage patterns

From an Easel checkout containing the lab template:

```sh
node test/preview.js lab docs/experiments/context-policy/lab.json --out test/out/context-policy.html
node test/preview.js lab docs/experiments/context-policy/summarizers.json --out test/out/context-summarizers.html
easel open --template lab --data docs/experiments/context-policy/lab.json --title 'Context policy measured results'
```

These files replay measured evidence in the review UI. They do not make new model calls. The experiment used an application-specific adapter in Sentience's private backend to exercise its actual agent factory, streaming SDK, summary function, history processors, and persistence serializer. That adapter and raw provider responses are not part of this public export.

## Experiment

Six chat policies were compared: raw replay; stored summary plus persisted pruning; native only; stored plus native; stored plus governor; and all layers. Chat used GPT Sol with medium reasoning on direct Azure. Native-enabled requests used `/openai/v1/responses`, `store:false`, and a compaction threshold of 160,000 provider tokens. OpenRouter handled production Gemini summaries and two Sol route-control runs with native compaction disabled.

Three scenarios used two deterministic fixture seeds each: a 70k-token conversation, a 175k-token conversation, and a 175k-token tool-loop checkpoint. The source contained an opening-only response instruction, an audit code, a corrected project and budget, an accepted decision with its reason, an ambiguous recipient, and a retracted claim that an invoice had been sent. Each run answered a factual request, handled an ambiguous send request, and resumed after persistence. Tools were deterministic fixtures and performed no external actions.

The existing stored-summary policy used Gemini Flash at 60k estimated conversation-text tokens, retaining a 20k tail. Persisted tool pruning triggered at 100k estimated tokens. The governor triggered at 140k estimated tokens, targeted 120k, and protected the newest 80k. The application uses a character estimator for these thresholds; they are not the same units as provider tokens.

Thirty-five of 36 chat-policy runs completed and passed all six checks. One run returned an Azure HTTP 500 and remains an error with unknown usage. Both route controls passed. Six additional runs compared Gemini, Sol, and Sol with native compaction as one-shot summarizers. The batch recorded 165 HTTP attempts and eight native compactions. A separate setup HTTP 400 is excluded from these trial counts and documented in the lab.

## Gotchas

- **Cost basis:** Sol uses common OpenAI list rates, including cache writes: $4/M ordinary input, $5/M writes, $0.40/M reads, and $20/M output. Gemini uses reported upstream BYOK cost plus router fee. These are not verified Azure invoice savings. [Sol pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching).
- **Summary cache confound:** later arms sometimes reused Gemini prompt caches. Lower summary charges in those arms do not show that their governor/native flag made summarization cheaper. The large-tool comparison invoked no summarizer and avoids this confound.
- **Failures:** the HTTP 500's charge is unknown. Known usage corresponds to approximately $22.32 under the stated mixed normalization; a complete experiment invoice is not established. Automatic chat transport retries were disabled consistently.
- **Summarizer fidelity:** native omitted the audit code on one seed. Gemini omitted the fixture's artificial reference labels on both seeds, while preserving tested facts; chat recovered cited records through fixture tools. This does not establish how every production citation format behaves.
- **Scope:** historical retrieval was a sunk cost outside the replay checkpoint. The full ChatService/UI, real users, audio summaries, multiple compactions in one conversation, and route changes after compaction were not evaluated.
- **Statistics:** seeds are paired within scenarios. The 44 runs are not 44 independent production tasks. Small-sample latency percentiles in the generic renderer must not be read as production p95.
- **Recommendation:** retain stored summaries and pruning; use the governor for large retrieval loops; keep native opt-in. Preserve original inputs to one-shot summarizers. Audio agents with retrieval loops need their own transcript-fidelity checks before applying the tool-result policy.
