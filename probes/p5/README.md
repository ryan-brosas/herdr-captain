# Probe P5: recovery tracer

This folder holds the probe P5 recovery tracer, its `hc` boundary module, a fake `hc` child program, and the offline test suite.

This is proof for the tracer, not for real Pi `/reload` wiring.

## Run the offline tests

The tests use Bun and standard library modules only, with no install step and no network access.

Run the test suite:

```sh
bun test probes/p5
```

Run the negative controls (each runs a mutated scratch copy and checks that the matching test fails):

```sh
bun probes/p5/negative-controls.mjs
```

## Command shapes for a later live run

A later ticket runs this tracer against a real `hc` binary. Pass an explicit `hc` path that contains `/`. The tracer refuses to start without one and never searches `PATH`.

Pick a random `<prefix>` (for example `p5-<hex8>`) and a temporary `<scratch>` folder before starting. Keep every terminal name to at most 32 characters (`a-z`, `0-9`, `-`, `_`, `.`).

1. Start and end the controller with `SIGKILL` at a named crash point (`after_receipt`, `after_intent_before_launch`, or `after_launch_before_receipt`):

```sh
bun probes/p5/tracer.mjs start \
  --hc-bin <hc-bin> \
  --state-root <scratch>/state \
  --project-key <project-key> \
  --issue <issue> \
  --prefix <prefix> \
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

3. Clean up every terminal carrying `<prefix>-` and read each removed terminal back by address:

```sh
bun probes/p5/tracer.mjs cleanup \
  --hc-bin <hc-bin> \
  --prefix <prefix>
```
