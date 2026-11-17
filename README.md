# System One gates for DSH

Decision gates for the [DeepSeek Harness](https://github.com/deepseek-ai/dsh) agent loop, driven by a
decision model that answers with calibrated probabilities instead of prose.

An agent that grades its own work grades it generously. This plugin moves three judgements out of the
model's head and into a separate decision call, where the answer is a probability the plugin turns into
policy: return the turn, deny the command, drop the paragraph.

It works with any decision endpoint and with any OpenAI-compatible chat API that can be asked for JSON.

## What it installs

Three gates that run by themselves:

| Gate | Hook | Question it answers |
|---|---|---|
| Conclusion checker | `agent/turn-stopping` | Does this turn's raw tool output support the final claim? |
| Shell risk gate | `tools/pre-execute` | How risky and how far out of scope is this command? |
| Injection filter | `tools/post-execute` | Is this block of fetched text data, or an instruction aimed at the reader? |

Three tools the model can call on demand, over the same questions:

| Tool | Arguments | Returns |
|---|---|---|
| `systemone_command_risk` | `command`, `request` | `action`, `risk`, `scope`, `certainty`, `reason` |
| `systemone_conclusion_check` | `claim`, `evidence` | `verdict`, `unsupported`, `certainty` |
| `systemone_injection_scan` | `text`, `source` | `verdict`, `judged`, `blocks[]` |

And a thresholds form on the Plugins page, so the numbers are edited without touching YAML.

## Requirements

- DSH 0.2.1 or newer, with a profile you can install bundles into.
- `pnpm` on the `PATH` of the DSH process. The bundle installer uses it. Without it the Harness answers
  `dsh: pnpm was not found; install pnpm and make it available on PATH`.

## Install

From the Web UI: **Plugins → Add plugin → `/absolute/path/to/this/repo`**.

Or with the CLI:

```sh
dsh plugin --profile web add /absolute/path/to/this/repo
```

Then confirm the row is live:

```
plugin_manager list_plugins
```

## Configure the provider

Everything lives in the bundle's `cordis.patch.yml`, and a deployment overrides any key by id in its own
profile patch. The two keys that matter most:

| Key | Default | Meaning |
|---|---|---|
| `provider` | `systemone` | `systemone` for a decision endpoint, `openai` for a chat API |
| `model` | `typesafe/jev` | model id passed to the provider |
| `baseURL` | adapter default | full endpoint for `systemone`, API root for `openai` |
| `apiKeyEnv` | `DECISION_API_KEY` | name of the environment variable (or harness credential) holding the key |
| `jsonMode` | `true` | send `response_format: json_object` to an `openai` provider |

### `systemone`

`POST <baseURL>` with `{ model, state, questions }`, answering `{ answers }` where every answer carries
probabilities. This is the calibrated path: the reference provider is Command Code,
`https://api.commandcode.ai/provider/v1/systemone`, model `typesafe/jev`.

### `openai`

`POST <baseURL>/chat/completions` with the state and the typed questions in the prompt, asking for one
JSON object. The adapter normalizes what comes back (choice probabilities are renormalized to sum 1) and
drops answers it cannot read, so the gate falls back honestly.

Honest limitation: a chat model's numbers are prompted, not calibrated. They are good enough to set
thresholds on, not to measure with. Prefer a decision endpoint when one exists.

### Thresholds

| Key | Default | Meaning |
|---|---|---|
| `askBelow` | `0.65` | below this certainty the gate applies its low-confidence action |
| `conclusion.blockBelow` | `0.50` | probability of "unsupported" that returns the turn |
| `bashRisk.blockAtRisk` | `2` of 3 | risk score from which a command is denied |
| `bashRisk.scopeBelow` | `0.75` | minimum scope for a writing command |
| `injection.blockAbove` | `0.60` | probability of an explicit instruction that removes the block |
| `injection.noteAbove` | `0.40` | probability of suspicion that annotates the block |

The form exposes exactly these six. Everything else stays in YAML.

Saved values are written to the profile patch as a full override, which then wins over this bundle's
defaults. `Restore defaults` removes the keys the form wrote.

## Privacy

- The privacy guard refuses to send a state that contains any string listed in `privacy.markers`. The
  default is empty: a deployment supplies its own file names and private paths.
- The audit log records the verdict, the model and a hash of the state, never the state itself.
- `log.dir` empty writes to `systemone-logs` inside the system temporary directory.

## Tests

```sh
npm test
```

The suite runs every gate against a local fake endpoint: 20 cases plus the privacy guard, the circuit
breaker, the log format, the two-turn evidence window and the partial-config merge. No network, no
provider credit.

## Costs

One decision call per inspected command, per turn that claims completion, and per judged paragraph. A
state is a few hundred tokens. With the reference provider's decision model at US$ 0.042 per million
input tokens, a thousand verdicts cost well under two cents.

## Limits worth knowing

- The shell gate reads the command line. A script that deletes from the inside, variable substitution and
  encoded payloads pass. Documented, not hidden.
- The conclusion checker sees the current turn and the previous one, not the whole session. Claims about
  work done many turns ago have no evidence behind them.
- The injection filter errs both ways: an instruction without an imperative passes, and a legitimate page
  about security can be annotated by mistake.
- The hooks and `agent.steer` are DSH internals, not a stable public API. Run `npm test` after upgrading.

## License

MIT. See [LICENSE](LICENSE).

Built by [Kara AI](https://github.com/kara-aiassistant-aquelegabes) with
[Gabriel Santos](https://github.com/aquelegabes) as co-author.
