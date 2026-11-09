# Validation, 2026-11-08

This page retains version 0.1.0 evidence. For version 0.1.1, use the [two-instance live comparison](ab-3080-3082.zh.md) and [per-turn provider usage](ab-3080-3082.json). The latest complete audit task preserved accuracy but increased input by 7.27% and active-turn latency by 83.70% across two replications; it does not support an overall savings claim.

The plugins reduce long-session input, but this validation does **not** establish equal accuracy, zero overhead, or lower bills for every workload. The initial live activation reduced tokens while increasing cost. This result is retained below rather than reported as a cost saving.

The independent package targets published DSH **0.2.2-rc.1**. Upstream was fetched at `fcc0ad4621`. No Harness production code changes are required. Measurements used Node **v24.15.0**, macOS x64. Aggregates are in [measurements.json](measurements.json); private writing content, Session IDs and credentials are excluded.

## Behavior and accuracy

Final verification: **62 tests across 6 files passed**. V8 coverage reports **97.33% lines, 83.68% branches**, 92.42% statements and 95.31% functions. Type checking and the ESM/declaration build passed. This is the independent package's verification, not a claim that the Harness monorepo's full coverage gate was run.

The final keyless suite covers configuration rejection, replay and checkpoint invalidation, surface replacement, recent-step protection, Unicode previews, small metadata preservation, oversized metadata protection, minimum batch savings, exact manual summary references, missing recall tools, summary failures and cancellation, and logged summary instructions. Overflow recovery and model switching exercise public lifecycle waterfalls. The switch test records the known first-request absolute-budget exception while checking the host's model-window safety.

Recall tests cover exact original text across multibyte pages, complete rendered-output budgets, search-window edges, current-step and cross-Session exclusion, cursor ownership, cancellation and unload. Two deterministic barriers reproduced failure when a pending recall outlived the plugin or token-meter provider; capturing the pure estimator before the read fixes both cases. The summary cancellation case also failed before its post-await guard was added.

An independent four-fact oracle checks an exact artifact tag, retry limit, error evidence and an earlier user file-preservation instruction after a deliberately lossy summary. Recovery must actually call search/read against original events and return the original values; the seed history must remain unchanged. A separate test focuses on a sentinel in the middle of a shortened result. These are scripted model tests of the complete data path, **not a measured real-model accuracy rate**.

The recorded-session case launches the installed DSH headless profile and replays summaries, pruning, original-history search/read and final exact output through the shipped replay adapter. Fixtures contain only synthetic records. The API-key e2e attempt returned **402 QUOTA / Insufficient Balance** and produced no usage; it is a failed external prerequisite, not a passing real-model test. The live application tests below used its existing working account instead.

## Deterministic token comparisons

All input counts here are host heuristic estimates, including auxiliary summary requests. `plain` means Basic without the new recall tools. The same-catalog Basic control isolates provider overhead from the fixed cost of registering tools.

| Workload | Plain input | Default plugin input | Change | Plugin summaries |
|---|---:|---:|---:|---:|
| 8 synthetic tool steps | 42,032 | 43,760 | +4.11% | 0 |
| 96 synthetic tool steps | 4,630,382 | 4,649,006 | +0.40% | 0 |
| 512 synthetic tool steps | 130,050,259 | 37,479,646 | **−71.18%** | 4 |

The short and medium cases remain below the default 131072 budget, so they pay the tool-schema cost without compression savings. The schema regression guard estimates the tools below 200 tokens; the benchmark's exact request delta is **192 heuristic tokens per request**. At 512 steps, peak request input falls from 506378 to 130885. Summary output and input are both included in the aggregates.

In a separate 96-step real Bash-tool lane, explicit `pruneToolResults: true` with target ratio 0.5 reduces input from 4,979,873 to 3,198,625 (**−35.77%**). All 89 replaced results preserve their original small metadata. The real read-tool lane performs no pruning: 72 of 96 metadata records exceed the 4096-character protection limit, and the remaining candidates do not meet the full-batch recovery minimum. This prevents treating simplified synthetic results as evidence that all production tools will shrink.

## Cache diagnostics and default selection

Canonical request-prefix character counts are an approximation, not tokenizer output or server cache units. At 512 steps, the default policy increases new-prefix characters by 20.00% while reducing cumulative input substantially. Weighting reused characters at 0.02 of new characters gives a theoretical input-cost ratio of **0.4343**. The explicit pruning variant gives **0.4778**, despite saving more raw tokens. These figures do not include real provider cache-unit persistence, eviction, output billing or network behavior.

At 96 steps, optional pruning with ratios 0.75, 0.5 and 0.25 reduces raw input but increases theoretical input cost at the same 0.02 ratio by approximately **13.14%, 3.01% and 6.46%**. Accordingly, early tool pruning is **off by default**. A deployment can opt in after measuring its own workload. Neither a shorter prompt nor a high cache-hit percentage alone proves a lower bill.

## Live application A/B

A real writing Session on localhost:3080 was idle before installation. The original account, model (`deepseek-official/deepseek-flash`), maximum reasoning setting and project instructions were retained. Three read-only forks use the same completed-history cut and identical audit instruction: Basic before installation, first plugin activation, and a warm repeat. No writing or delegation was requested. Actual tool calls were read-only. The original Session was then separately asked to continue one bounded optimization round with its existing author/reviewer/ledger workflow.

| Provider-reported measure | Basic, warm existing history | Plugin, first activation | Plugin, warm repeat |
|---|---:|---:|---:|
| Uncached input | 2,883 | 702,980 | 66,464 |
| Cache-read input | 1,369,088 | 70,656 | 853,248 |
| **Total input, including summary** | **1,371,971** | **773,636** | **919,712** |
| Input reduction against Basic | — | **43.61%** | **32.97%** |
| Output, including summary | 3,115 | 4,870 | 11,900 |
| Main + summary requests | 2 + 0 | 2 + 1 | 4 + 1 |
| End-to-end turn time | 32.06 s | 42.38 s | 81.89 s |

Cache-write usage was zero in all three runs. The first activation had a cold fill while the tool catalog and selected history changed; these samples do not isolate those causes or the server's prefix-unit persistence. Its main requests contained **67164** and **70800** input tokens, compared with Basic's **684032** and **687939**. The second plugin main request hit **96.36%** of input from cache. The warm repeat summary reused **635520 of 635672** input tokens (**99.98%**), and subsequent main steps hit above 99% before the final new file output. This supports stable prefix reuse after activation; it does not promise cache residency.

At the [official Flash off-peak prices](https://api-docs.deepseek.com/quick_start/pricing/) checked on this date ($0.15/M uncached input, $0.003/M cached input, $0.60/M output), the three runs illustrate approximately **$0.00641, $0.10858 and $0.01967**, respectively. These are usage-based estimates, not account invoices. **Both plugin activation runs cost more than this already-hot short audit.** The warm repeat also made more model calls and generated more output. Sustained savings require enough subsequent work to amortize activation and summary costs; the synthetic long run must not be substituted for a measured live long-run bill.

All three answers preserved the opening and open-ending constraints, identified unresolved audit work, and pointed to the correct next audit record. Their remaining details differed, so this is a limited task check rather than semantic equivalence or a universal accuracy guarantee. The real-model timing samples have different generated outputs and tool paths and do not isolate plugin latency.

## Local execution overhead

Timing uses fresh plain-Node processes, actual AgentLoop/Session/tool/meter behavior and a scripted LLM. Initialization and model/network time are excluded. Three samples per variant are reported as medians; prefix instrumentation runs separately.

| 96-step lane | Basic plain | Default plugin | Difference |
|---|---:|---:|---:|
| Synthetic | 211.12 ms | 224.49 ms | +6.33% / +13.37 ms |
| Real read tool | 450.81 ms | 451.29 ms | +0.11% |
| Real Bash subprocess tool | 7242.28 ms | 7180.99 ms | −0.85% |

The synthetic same-catalog Basic control is 227.15 ms, slightly slower than the default provider's 224.49 ms. Synthetic retained-heap delta is essentially unchanged (2.115 MB to 2.114 MB); median RSS rises from 82.88 MB to 85.31 MB. In real-tool lanes, full process RSS also rises (roughly 9–15 MB), so unchanged retained projection size is not a zero-memory-overhead claim. Optional Bash pruning adds about 5.58% local wall time. Sampling is too small to establish a general latency guarantee.

## Reproduction and remaining limits

```sh
pnpm run typecheck
pnpm run build
pnpm run test:coverage
node tests/performance/run.mjs
node tests/performance/prefix.mjs
node tests/performance/policies.mjs
node tests/performance/extended.mjs
```

The local release archive was installed through the published `dsh plugin` command into an isolated profile; composition and startup succeeded, and removing it restored Basic. It was then installed into only the 3080 Web profile, where both plugin fibers became active and Basic became disabled. Other DSH instances use separate homes.

Recall still obtains one complete host Session snapshot per explicit call. Its output and scan budgets do not bound that underlying allocation. Recent protected or indivisible content can exceed the absolute target. First-request model switches use the host's own window threshold. Pending-summary teardown of the entire enclosing host has not been exhaustively verified. Compression remains lossy; original-history recall and representative tests cannot guarantee every model will recover every omitted fact.
