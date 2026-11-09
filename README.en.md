# dsh-context-kit

Budgeted context compression and bounded history recall for DeepSeek Harness. One installable bundle contains two Cordis plugins: `dsh-context-kit/budgeted` and `dsh-context-kit/recall`.

This package is developed and versioned independently of Harness. It uses the published Harness APIs and currently targets **DSH 0.2.2-rc.1** on Node 24.9 or later. It does not patch the agent loop or provider serialization.

The latest paired live test does **not** meet the complete-task savings goal: version 0.1.1 preserved 13/13 answer fields in both replications, but averaged 7.27% more input and 83.70% longer active-turn time. Warm followup input fell 60.24%; that partial saving did not offset earlier work. See the [complete 3080/3082 comparison](docs/ab-3080-3082.zh.md), [historical validation](docs/validation.md) and [distribution guide](docs/distribution.md). [中文首页](README.md)。

## Install directly from GitHub

The tested prebuilt package is stored in this public repository. Install it into the profile you use:

```sh
dsh plugin --profile web add https://raw.githubusercontent.com/Bruce7777/dsh-context-kit/main/release-assets/dsh-context-kit-0.1.1.tgz
```

See the [installation guide](docs/installation.zh.md) for profile selection, configuration, verification and removal. The supported GitHub installation uses the prebuilt archive; the repository's automatic source-build lifecycle is not an installation prerequisite. npm and community-market publishing are deferred.

The bundle disables the profile's `compaction-basic` row and selects the budgeted provider with the recall tools. Base-backed Web, headless, SDK and ACP profiles provide the required services. HMR applies supported changes live; otherwise restart that profile. Desktop owns a separate profile: use the Desktop application's own plugin manager.

Disable or remove this bundle to restore the underlying profile's basic compactor. Do not enable both providers in one context. Other plugins and user patches may override these selections.

Presets may mount an additional isolated Basic provider. The bundle replaces the profile's top-level row and does not rewrite arbitrary presets; disable automatic Basic in the active preset, or use your own composition without that compaction group, to ensure a single automatic provider. Service isolation alone does not filter the top-level provider's event hooks. See the installation guide.

## Budgeted compression

The provider considers an absolute active-context budget before the host's model-window pressure limit, using the host's existing summary transaction and tool-pairing checks. Optional early pruning batches eligible older tool results into smaller previews. Recent complete steps, errors, rich content and oversized metadata stay protected; small result metadata remains unchanged beside its preview.

Original events remain in the append-only Session. Previews and summaries contain code-generated references that the model can read with `context_read`; search is available when the missing fact's location is unknown.

| Setting | Default | Purpose |
|---|---:|---|
| `pruneToolResults` | false | Opt into early tool-history batches; disabled to avoid repeatedly invalidating warm history. |
| `maxContextTokens` | 131072 | Soft upper target for active context; the model's smaller safe limit still applies. |
| `toolHistoryTokens` | 32768 | Accumulated tool-result budget that can trigger a batch. |
| `toolHistoryTargetRatio` | 0.75 | Target after a tool-history batch. |
| `protectedSteps` | 2 | Most recent complete steps protected from early reduction. |
| `minSavingsTokens` | 1024 | Minimum estimated useful reduction. |
| `toolHeadChars` | 1024 | Unicode code points retained from an eligible result's start. |
| `toolTailChars` | 512 | Unicode code points retained from its end. |
| `toolMetaMaxChars` | 4096 | Maximum complete JSON metadata retained unchanged beside a preview. |
| `summaryTargetTokens` | 4096 | Requested summary text target. |

Ordinary Basic compaction options remain available. The default recent-history retention is 24576 tokens and the summary generation cap is 16384 tokens. A generation cap includes provider output semantics and is not a promise that every summary reaches the text target. A failed or truncated summary preserves the host's failure behavior.

## History tools

- `context_search` searches literal text in earlier events of the calling Session. Omit sequence limits to search all earlier text. Hits include bounded excerpts and `read` arguments for direct original-text retrieval; incomplete pages retain continuation cursors.
- `context_read` reads an inclusive event range or a search hit's single-event `part`/`offset` location. Parts index visible text; offsets count UTF-16 code units at complete Unicode scalar boundaries.

The defaults inspect up to 1,048,576 text code units and 256 events per search page, with excerpts up to 2048 code units. Complete output remains capped at 2048 heuristic tokens and 8192 UTF-8 bytes. Separate matches in one block remain reachable when paging.

The tools exclude the executing step, other Sessions, reasoning blocks and log-only records from their model-facing text. Read cursors retain the position inside oversized records so paging does not discard their middle. Cursors are Session-specific. Original data that a tool already spilled outside the Session still depends on that spill's availability.

On the current host, an explicit recall call obtains one complete immutable Session snapshot before applying scan and output limits. Those limits bound processing and returned content, **not the host's underlying snapshot allocation**. Recall performs no background model requests or per-step history loads.

## Cache behavior

Unchanged requests retain the host's ordering and serialization. Installing the recall tools changes the tool catalog once and can require a cold-cache fill. Tool schemas then remain static. Optional batches require a full minimum recovery before replacing history; summary calls reuse the host's conversation prefix before appending guidance. A real replacement necessarily invalidates the cache from its first changed history token. Provider cache residency, expiry and routing remain outside this package.

Evaluate total work, including summary calls, recall calls and cold-cache recovery. Fewer context tokens alone do not establish a lower bill. `docs/validation.md` records executed evidence and its limits.

## Development and verification

```sh
pnpm run typecheck
pnpm test
pnpm run test:coverage
pnpm run test:e2e
pnpm run build
```

Real-provider cases self-skip without `DEEPSEEK_API_KEY`. They compare exact fixture facts and user constraints and report uncached input, cache reads, cache writes and output for every model call. Performance diagnostics use fixed synthetic records; private user Sessions never become fixtures.

## Distribution

GitHub hosts the source, documentation and versioned prebuilt archives in `release-assets/`. See [release maintenance](docs/distribution.md). npm publishing and market indexing are future steps; this release is installed from its GitHub archive URL.

## Limitations

Compression is lossy; recall makes retained originals reachable but cannot ensure a model always notices a missing fact. The configured active budget is a soft target when recent protected or indivisible content dominates. The host's model-switch handler applies its own window limit before the first switched request; the absolute plugin budget applies on subsequent ordinary pressure checks. The initial release supports the tested Harness version; other versions need compatibility validation. Savings and model latency vary with the task, model and cache state.
