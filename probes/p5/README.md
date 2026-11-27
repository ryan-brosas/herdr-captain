# Probe P5: recovery tracer

This folder holds the probe P5 recovery tracer, its `hc` boundary module, a fake `hc` child program, and the offline test suite.

This is proof for the tracer, not for real Pi `/reload` wiring.

The fold in `ledger.mjs` and the allow-list in `hc-boundary.mjs` are hand-written probe code checked by tests and negative controls, not the compiled policy kernel of ADR-0003 that Slice S2 builds and proves.

## Run the offline tests

The tests use Bun and standard library modules only, with no install step and no network access.

Run the test suite:

```sh
bun test probes/p5
```

Run the negative controls (each runs a mutated scratch copy and checks that the matching assertion fails):

```sh
bun probes/p5/negative-controls.mjs
```

## Command shapes for a later live run

A later ticket runs this tracer against a real `hc` binary. Pass an explicit `hc` path that contains `/`. The tracer refuses to start without one and never searches `PATH`.

The boundary accepts a prefix in one fixed shape only: `p5-` plus 8 to 16 lowercase letters or digits (`^p5-[a-z0-9]{8,16}$`). It refuses any other prefix before starting a process. A terminal name belongs to the probe only if it starts with `<prefix>-`, has a non-empty suffix, and has at most 32 characters (`a-z`, `0-9`, `-`, `_`, `.`).

1. Start and end the controller with `SIGKILL` at a named crash point (`after_receipt`, `after_intent_before_launch`, or `after_launch_before_receipt`). Omit `--prefix` to generate a random cryptographic prefix (`p5-<12 hex>`). `start` prints `prefix=<prefix>` on stderr (and `prefix` in stdout JSON) for `recover` and `cleanup`:

```sh
bun probes/p5/tracer.mjs start \
  --hc-bin <hc-bin> \
  --state-root <scratch>/state \
  --project-key <project-key> \
  --issue <issue> \
  --cwd <scratch> \
  --expected-lines 250 \
  --report-file <scratch>/report.txt \
  --crash-at <crash-point>
```

2. Recover in a fresh process. The new controller acquires the owner lease, folds the commit log, and acts as section 8 of `docs/architecture.md` specifies:

```sh
bun probes/p5/tracer.mjs recover \
  --hc-bin <hc-bin> \
  --state-root <scratch>/state \
  --project-key <project-key> \
  --issue <issue> \
  --prefix <prefix> \
  --read-lines 1000
```

3. Clean up every terminal carrying `<prefix>-` under the owner lease. Read each removed terminal back by address:

```sh
bun probes/p5/tracer.mjs cleanup \
  --hc-bin <hc-bin> \
  --state-root <scratch>/state \
  --project-key <project-key> \
  --prefix <prefix>
```

## `hc` response fields and error kinds read by this probe

Every response field and error kind read by `hc-boundary.mjs`, `tracer.mjs`, and `capture.mjs` comes from `hc schema --json` (`hc` `0.1.22`), `hc --skill`, or `docs/probes/p3.md`.

| Surface | Field or error kind | Read by | Source |
|---|---|---|---|
| `hc schema --json` | `openrpc`, `methods` | `hc-boundary.mjs` | `hc schema --json` top-level OpenRPC document; P3 `e1-schema` |
| `hc run --bg --json` (`RunResult`) | `address`, `state`, `name`, `turn`, `first_message` | `hc-boundary.mjs`, `tracer.mjs` | `hc schema --json` `RunResult` (`address`, `state`, `name`, `turn`, `first_message`); P3 `a1-run-named`, `b1-run-parent`, `c1-run-report` |
| `hc get --json` (`Terminal`) | `address`, `name`, `state`, `labels`, `argv`, `cwd`, `created_ms`, `cols`, `rows`, `screen`, `keep`, `exit_code`, `signal`, `reason`, `turn`, `status`, `first_message` | `hc-boundary.mjs`, `tracer.mjs`, `capture.mjs` | `hc schema --json` `Terminal`; P3 `a2-get-by-name`, `b2-get-outlive-while-parent-alive`, `b6-get-plain-after`, `c3-get-finished-by-address`, `hc get` top-level keys |
| `Status` (`Terminal.status`) | `state` | `hc-boundary.mjs`, `tracer.mjs` | `hc schema --json` `Status.properties.state`; P3 `e2-get-own-1` to `e2-get-own-6`, Behaviour 5 |
| `FirstMessage` (`RunResult.first_message`, `Terminal.first_message`) | `sent`, `reason`, `started`, `turn` | `hc-boundary.mjs`, `tracer.mjs` | `hc schema --json` `FirstMessage`; `hc --skill` lines 51 to 53; P3 `e2-get-own-1`, `e2-get-own-2` |
| `hc ls --all --json` (`ListResult`) | `terminals` (items: `address`, `name`, `state`), `hidden_finished`, `machines` | `hc-boundary.mjs`, `tracer.mjs` | `hc schema --json` `ListResult`, `Terminal`; P3 `c8-ls-all` |
| `hc read --json` (`ReadResult`) | `text`, `complete`, `how`, `why` | `hc-boundary.mjs`, `tracer.mjs`, `capture.mjs` | `hc schema --json` `ReadResult`; `hc --skill` lines 74 to 76; P3 `c4-read-1000-json`, `c5-read-50-json` |
| `hc wait --json` (`WaitResult`) | `terminal`, `ended`, `reason`, `turn`, `children`, `exit_code`, `signal`, `status` | `hc-boundary.mjs`, `tracer.mjs` | `hc schema --json` `WaitResult`; P3 `b3-wait-parent`, `b7`, `b8`, `c2-wait-report` |
| `hc kill --json` (`Terminal`) | `address`, `name`, `state` | `hc-boundary.mjs`, `tracer.mjs` | `hc schema --json` `terminal.kill` result (`Terminal`) |
| `hc rm --json` (`RemoveResult`) | `removed` | `hc-boundary.mjs` | `hc schema --json` `RemoveResult.properties.removed` |
| `stderr` error envelope | `error.kind` (`error.message` and `error.hint` checked for JSON type only) | `hc-boundary.mjs` | `hc --skill` line 347 (`{error: {kind, message, hint}}` on stderr); P3 `a4-run-duplicate-name`, `d2-get-self-no-id` |
| `terminal.run` definite non-delivery kinds | `invalid_params`, `name_taken`, `spawn_failed`, `invalid_template`, `not_found`, `machine_unknown`, `config` | `hc-boundary.mjs` | `hc schema --json` `terminal.run` errors (all listed kinds except `unavailable`); P3 `a4-run-duplicate-name` |
| `terminal.run` ambiguous error kind | `unavailable` | `hc-boundary.mjs` | `hc schema --json` `terminal.run` errors (`unavailable` stays uncertain) |
| Missing terminal exit and error kind | exit `3` with `error.kind === "not_found"` | `hc-boundary.mjs`, `tracer.mjs` | `hc --skill` line 348 (`3 not_found`); `hc schema --json` `terminal.get`, `terminal.read`, `terminal.wait`, `terminal.kill`, `terminal.rm` errors; P3 `N6` |
| `terminal.rm` live-terminal error kind | `live` | `hc-boundary.mjs`, `tracer.mjs` (`fake-hc.mjs` emits it) | `hc schema --json` `terminal.rm` errors (`live`) |
| `hc run` address-in-output guard | keys `address` and `terminal` in parsed output; address token `t<n>` in stdout | `hc-boundary.mjs` | `hc schema --json` `RunResult.properties.address`, `WaitResult.properties.terminal`; `docs/architecture.md` section 8 |

Error `message` and `hint` fields are free text in `hc`. No code path and no test depends on their wording. Any response that does not match its schema type counts as unknown, leaves the attempt `uncertain`, and escalates.

Neither `hc schema --json` nor `hc --skill` records what a registry save failure looks like. Line 150 of `hc --skill` notes only that the program may already have run and tells callers to check `hc ls --all`. Any `hc run` failure that misses one of the four definite non-delivery checks follows section 8 row 2. It looks up the terminal by name, keeps the attempt `uncertain`, escalates, and never launches again.

## Fixture protocol in `fake-hc.mjs`

The control channel in `fake-hc.mjs` is fixture protocol for offline tests, not `hc` behaviour:

- State folder set by `FAKE_HC_STATE_DIR` (exits `2` on missing or invalid fixture setup).
- Fault and sync env vars: `FAKE_HC_PROC_TOKEN`, `FAKE_HC_HANG_CMD`, `FAKE_HC_HANG_MS`, `FAKE_HC_RUN_FIRST_MSG_UNSENT`, `FAKE_HC_FAIL_RUN_MODE`, `FAKE_HC_KILL_HOLDER_ON_CMD`, `FAKE_HC_OWNER_JSON`, `FAKE_HC_REPLACE_AFTER_WAIT`, and `FAKE_HC_INVALID_RESPONSE_CMD`.

All normal JSON payloads and error kinds returned by `fake-hc.mjs` follow `hc schema --json` and `hc --skill`.

## Left to Slice S3

This tracer records `uncertain` and escalates on every `hc wait` error. Two steps from `docs/architecture.md` section 8 belong to Slice S3 (`#10`), not this probe:

- Bounded retries when `hc wait` reports `unavailable`.
- File and commit checks after `hc wait` reports `not_found`.
