#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly REPO_ROOT
readonly PINNED_GIT_SHA="7fc96329add1d7604a27122e235acbbf04a78095"
readonly PI_FABRIC_SPEC="npm:pi-fabric@0.140.1"

CTRL_SCRATCH=""
ACTIVE_CHILD_PID=""
PI_PKG_DIR=""
RESOLVED_BUN_INSTALL=""

err() {
  printf 'probe-p1-controls error: %s\n' "$*" >&2
}

stop_active_child() {
  if [[ -z "$ACTIVE_CHILD_PID" ]]; then
    return 0
  fi
  if kill -0 "$ACTIVE_CHILD_PID" 2>/dev/null; then
    kill -TERM "$ACTIVE_CHILD_PID" 2>/dev/null || true
    local _
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ! kill -0 "$ACTIVE_CHILD_PID" 2>/dev/null; then
        break
      fi
      sleep 0.2
    done
    if kill -0 "$ACTIVE_CHILD_PID" 2>/dev/null; then
      kill -KILL "$ACTIVE_CHILD_PID" 2>/dev/null || true
    fi
  fi
  wait "$ACTIVE_CHILD_PID" 2>/dev/null || true
  ACTIVE_CHILD_PID=""
}

cleanup() {
  stop_active_child
  if [[ -n "$CTRL_SCRATCH" && -d "$CTRL_SCRATCH" ]]; then
    rm -rf -- "$CTRL_SCRATCH"
  fi
}

on_signal() {
  local code="$1"
  trap - INT TERM HUP
  exit "$code"
}

run_bounded_in_dir() {
  local seconds="$1"
  local out_file="$2"
  local work_dir="$3"
  shift 3

  local rc=0
  (
    cd -- "$work_dir" || exit 1
    exec timeout --kill-after=10s "${seconds}s" "$@"
  ) >"$out_file" 2>&1 &
  ACTIVE_CHILD_PID=$!
  if wait "$ACTIVE_CHILD_PID"; then
    rc=0
  else
    rc=$?
  fi
  ACTIVE_CHILD_PID=""
  return "$rc"
}

assert_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if ! grep -Fq -- "$needle" "$file"; then
    err "$label: expected output to contain: $needle"
    printf '--- captured output (%s) ---\n' "$label" >&2
    cat -- "$file" >&2
    return 1
  fi
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq -- "$needle" "$file"; then
    err "$label: output unexpectedly contained: $needle"
    printf '--- captured output (%s) ---\n' "$label" >&2
    cat -- "$file" >&2
    return 1
  fi
}

assert_exit_code() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  local out_file="$4"
  if (( actual != expected )); then
    err "$label: expected exit code $expected, got $actual"
    if [[ -f "$out_file" ]]; then
      printf '--- captured output (%s) ---\n' "$label" >&2
      cat -- "$out_file" >&2
    fi
    return 1
  fi
}

copy_probe_repo() {
  local dest="$1"
  mkdir -p -- "$dest/src" "$dest/probes/p1" || return 1
  cp -- "$REPO_ROOT/package.json" "$dest/package.json" || return 1
  cp -- "$REPO_ROOT/src/index.ts" "$dest/src/index.ts" || return 1
  cp -- "$REPO_ROOT/probes/p1/run.sh" "$dest/probes/p1/run.sh" || return 1
  cp -- "$REPO_ROOT/probes/p1/probe-fabric.ts" "$dest/probes/p1/probe-fabric.ts" || return 1
  chmod +x -- "$dest/probes/p1/run.sh" || return 1
}

write_dummy_dotenv() {
  local dest="$1"
  cat > "$dest" <<'EOF'
ANTHROPIC_AUTH_TOKEN=dummy-dotenv-anthropic-token
AZURE_OPENAI_API_KEY=dummy-dotenv-azure-key
OPENAI_API_KEY=dummy-dotenv-openai-key
PI_FABRIC_KERNEL=python
PI_FABRIC_PYTHON_RUNTIME=monty
EOF
}

resolve_host_tools() {
  local scratch_cwd="$1"
  if [[ -n "${BUN_INSTALL:-}" && -d "${BUN_INSTALL}" ]]; then
    RESOLVED_BUN_INSTALL="$(realpath -- "${BUN_INSTALL}")" || return 1
  elif [[ -n "${HOME:-}" && -d "${HOME}/.bun" ]]; then
    RESOLVED_BUN_INSTALL="$(realpath -- "${HOME}/.bun")" || return 1
  else
    RESOLVED_BUN_INSTALL=""
  fi

  if [[ -n "${PI_CODING_AGENT_PACKAGE_DIR:-}" && -f "${PI_CODING_AGENT_PACKAGE_DIR}/package.json" ]]; then
    PI_PKG_DIR="$(realpath -- "${PI_CODING_AGENT_PACKAGE_DIR}")" || return 1
    return 0
  fi

  local bun_bin_dir=""
  if command -v bun >/dev/null 2>&1; then
    bun_bin_dir="$(
      cd -- "$scratch_cwd" || exit 1
      bun --no-env-file pm bin -g 2>/dev/null || true
    )"
    if [[ -n "$bun_bin_dir" && -e "$bun_bin_dir/pi" ]]; then
      local pi_real
      pi_real="$(realpath -- "$bun_bin_dir/pi")" || return 1
      local dir
      dir="$(dirname -- "$pi_real")"
      while [[ "$dir" != "/" ]]; do
        if [[ -f "$dir/package.json" ]] && grep -q '"name"[[:space:]]*:[[:space:]]*"@earendil-works/pi-coding-agent"' "$dir/package.json"; then
          PI_PKG_DIR="$dir"
          return 0
        fi
        dir="$(dirname -- "$dir")"
      done
    fi
  fi

  local npm_root=""
  if command -v npm >/dev/null 2>&1; then
    npm_root="$(
      cd -- "$scratch_cwd" || exit 1
      npm root -g 2>/dev/null || true
    )"
    if [[ -n "$npm_root" && -f "$npm_root/@earendil-works/pi-coding-agent/package.json" ]]; then
      PI_PKG_DIR="$(realpath -- "$npm_root/@earendil-works/pi-coding-agent")" || return 1
      return 0
    fi
  fi

  err "Could not locate @earendil-works/pi-coding-agent; set PI_CODING_AGENT_PACKAGE_DIR"
  return 1
}

run_control_1_dotenv() {
  local base="$CTRL_SCRATCH/c1-dotenv"
  local caller_dir="$base/caller"
  mkdir -p -- "$caller_dir" || return 1
  write_dummy_dotenv "$caller_dir/.env" || return 1

  printf '=== Control 1 (S1): Caller-directory and repo-root .env isolation ===\n'

  # Positive pre-check: confirm unguarded Bun autoloads caller/.env.
  local pre_out="$base/precheck.log"
  local rc=0
  run_bounded_in_dir 30 "$pre_out" "$caller_dir" \
    env -i "PATH=$PATH" bun -e 'console.log(process.env.ANTHROPIC_AUTH_TOKEN ?? "")' || rc=$?
  assert_exit_code "$rc" 0 "Control 1 pre-check" "$pre_out" || return 1
  assert_contains "$pre_out" "dummy-dotenv-anthropic-token" "Control 1 pre-check" || return 1
  printf 'Pre-check (unguarded bun reads caller .env): exit=%d value=%s\n' "$rc" "$(tr -d '\r\n' < "$pre_out")"

  # Mode 1a: --offline-only from caller_dir containing .env.
  local out_offline="$base/offline.log"
  rc=0
  run_bounded_in_dir 60 "$out_offline" "$caller_dir" "$REPO_ROOT/probes/p1/run.sh" --offline-only || rc=$?
  assert_exit_code "$rc" 0 "Control 1a (--offline-only from .env caller dir)" "$out_offline" || return 1
  assert_contains "$out_offline" "Offline-only mode complete (Checks 1 and 2 passed)." "Control 1a" || return 1
  assert_not_contains "$out_offline" "dummy-dotenv-" "Control 1a" || return 1
  printf 'Caller .env + --offline-only: exit=%d (PASS)\n' "$rc"

  # Mode 1b: full run.sh from caller_dir containing .env.
  local out_full="$base/full.log"
  rc=0
  run_bounded_in_dir 180 "$out_full" "$caller_dir" "$REPO_ROOT/probes/p1/run.sh" || rc=$?
  assert_exit_code "$rc" 0 "Control 1b (full run.sh from .env caller dir)" "$out_full" || return 1
  assert_contains "$out_full" '"cwdInScratch": true' "Control 1b" || return 1
  assert_contains "$out_full" '"configuredAuthProviders": []' "Control 1b" || return 1
  assert_contains "$out_full" '"availableModelCount": 0' "Control 1b" || return 1
  assert_contains "$out_full" '"selectedModel": "unknown/unknown"' "Control 1b" || return 1
  assert_contains "$out_full" '"matched": true' "Control 1b" || return 1
  assert_contains "$out_full" "All Probe P1 local checks (1-4) passed." "Control 1b" || return 1
  local forbidden
  for forbidden in ANTHROPIC_AUTH_TOKEN AZURE_OPENAI_API_KEY OPENAI_API_KEY PI_FABRIC_KERNEL PI_FABRIC_PYTHON_RUNTIME dummy-dotenv-; do
    assert_not_contains "$out_full" "$forbidden" "Control 1b" || return 1
  done
  printf 'Caller .env + full run.sh (fabric-first and captain-first): exit=%d (PASS)\n' "$rc"

  # Mode 1c: --git-sha from caller_dir containing .env.
  local out_git="$base/git.log"
  rc=0
  run_bounded_in_dir 180 "$out_git" "$caller_dir" "$REPO_ROOT/probes/p1/run.sh" --git-sha "$PINNED_GIT_SHA" || rc=$?
  assert_exit_code "$rc" 0 "Control 1c (--git-sha from .env caller dir)" "$out_git" || return 1
  assert_contains "$out_git" '"label": "pinned-git"' "Control 1c" || return 1
  assert_contains "$out_git" '"cwdInScratch": true' "Control 1c" || return 1
  assert_contains "$out_git" '"configuredAuthProviders": []' "Control 1c" || return 1
  assert_contains "$out_git" '"availableModelCount": 0' "Control 1c" || return 1
  assert_contains "$out_git" '"matched": true' "Control 1c" || return 1
  for forbidden in ANTHROPIC_AUTH_TOKEN AZURE_OPENAI_API_KEY OPENAI_API_KEY PI_FABRIC_KERNEL PI_FABRIC_PYTHON_RUNTIME dummy-dotenv-; do
    assert_not_contains "$out_git" "$forbidden" "Control 1c" || return 1
  done
  printf 'Caller .env + --git-sha %s: exit=%d (PASS)\n' "$PINNED_GIT_SHA" "$rc"

  # Mode 1d: scratch copy of repo holding .env at repo root itself.
  local repo_copy="$base/repo-with-dotenv"
  copy_probe_repo "$repo_copy" || return 1
  write_dummy_dotenv "$repo_copy/.env" || return 1
  local out_repo="$base/repo-dotenv.log"
  rc=0
  run_bounded_in_dir 60 "$out_repo" "$repo_copy" ./probes/p1/run.sh --offline-only || rc=$?
  assert_exit_code "$rc" 0 "Control 1d (repo-root .env + --offline-only)" "$out_repo" || return 1
  assert_contains "$out_repo" "Offline-only mode complete (Checks 1 and 2 passed)." "Control 1d" || return 1
  assert_not_contains "$out_repo" "dummy-dotenv-" "Control 1d" || return 1
  printf 'Scratch repo-root .env + --offline-only: exit=%d (PASS)\n' "$rc"
}

run_control_2_wrapper_failure() {
  local base="$CTRL_SCRATCH/c2-wrapper"
  mkdir -p -- "$base/s3-fixture" || return 1

  printf '\n=== Control 2 (S3): Failed isolation assertion blocks fixture command in command substitution ===\n'

  local driver="$base/wrapper-cmdsub.sh"
  cat > "$driver" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
repo_root="$1"
scratch_dir="$2"
wrapper_fn="$3"
agent_name="$4"
canary_file="$5"

# shellcheck source=/dev/null
source "$repo_root/probes/p1/run.sh"
scratch_real="$(realpath -- "$scratch_dir")"
init_scratch_home "$scratch_real"
SAFE_PATH="$PATH"
RESOLVED_BUN_INSTALL="$(resolve_bun_install_dir)"
PI_PKG_DIR="$(resolve_pi_coding_agent_dir "$scratch_real/cwd")"

agent_dir="$scratch_real/$agent_name"
mkdir -p -- "$agent_dir"
printf '{}\n' > "$agent_dir/auth.json"

out=""
out="$("$wrapper_fn" "$agent_dir" "$scratch_real" touch "$canary_file")"
printf '%s\n' "$out"
EOF
  chmod +x -- "$driver" || return 1

  # Case 2a: online run_fixture_cmd inside command substitution.
  local out_online="$base/online.log"
  local online_canary="$base/online-canary"
  local rc=0
  run_bounded_in_dir 30 "$out_online" "$CTRL_SCRATCH/cwd" \
    "$driver" "$REPO_ROOT" "$base/s3-fixture" run_fixture_cmd agent-online-poisoned "$online_canary" || rc=$?
  assert_exit_code "$rc" 1 "Control 2a (online wrapper in command substitution)" "$out_online" || return 1
  assert_contains "$out_online" "Isolation check failed: fixture must not contain auth.json" "Control 2a" || return 1
  if [[ -e "$online_canary" ]]; then
    err "Control 2a failed: online fixture command executed despite failed isolation assertion"
    return 1
  fi
  printf 'Online run_fixture_cmd in command substitution: exit=%d canary_created=no error=%s\n' \
    "$rc" "$(grep -F 'Isolation check failed:' "$out_online" | head -n 1)"

  # Case 2b: offline run_offline_fixture_cmd inside command substitution.
  local out_offline="$base/offline.log"
  local offline_canary="$base/offline-canary"
  rc=0
  run_bounded_in_dir 30 "$out_offline" "$CTRL_SCRATCH/cwd" \
    "$driver" "$REPO_ROOT" "$base/s3-fixture" run_offline_fixture_cmd agent-offline-poisoned "$offline_canary" || rc=$?
  assert_exit_code "$rc" 1 "Control 2b (offline wrapper in command substitution)" "$out_offline" || return 1
  assert_contains "$out_offline" "Isolation check failed: fixture must not contain auth.json" "Control 2b" || return 1
  if [[ -e "$offline_canary" ]]; then
    err "Control 2b failed: offline fixture command executed despite failed isolation assertion"
    return 1
  fi
  printf 'Offline run_offline_fixture_cmd in command substitution: exit=%d canary_created=no error=%s\n' \
    "$rc" "$(grep -F 'Isolation check failed:' "$out_offline" | head -n 1)"

  # Case 2c: end-to-end scratch copy of run.sh --offline-only where auth.json appears right before offline pi list.
  local e2e_repo="$base/e2e-repo"
  local e2e_canary="$base/e2e-canary"
  copy_probe_repo "$e2e_repo" || return 1
  python3 -I - "$e2e_repo/probes/p1/run.sh" "$e2e_canary" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
canary = sys.argv[2]
text = path.read_text(encoding="utf-8")
target = '  list_output="$(run_offline_fixture_cmd "$agent_dir" "$scratch_real" pi list)" || return $?'
replacement = (
    '  printf "{}\\n" > "$agent_dir/auth.json"\n'
    f'  list_output="$(run_offline_fixture_cmd "$agent_dir" "$scratch_real" sh -c \'touch "$1"; exec pi list\' _ "{canary}")" || return $?'
)
if target not in text:
    raise SystemExit("Control 2c setup failed: target line not found in scratch run.sh")
path.write_text(text.replace(target, replacement, 1), encoding="utf-8")
PY
  local out_e2e="$base/e2e.log"
  rc=0
  run_bounded_in_dir 60 "$out_e2e" "$CTRL_SCRATCH/cwd" "$e2e_repo/probes/p1/run.sh" --offline-only || rc=$?
  assert_exit_code "$rc" 1 "Control 2c (end-to-end run.sh --offline-only)" "$out_e2e" || return 1
  assert_contains "$out_e2e" "Isolation check failed: fixture must not contain auth.json" "Control 2c" || return 1
  assert_not_contains "$out_e2e" "Offline-only mode complete" "Control 2c" || return 1
  if [[ -e "$e2e_canary" ]]; then
    err "Control 2c failed: offline pi list executed despite failed isolation assertion"
    return 1
  fi
  printf 'End-to-end run.sh --offline-only (auth.json before offline pi list): exit=%d canary_created=no error=%s\n' \
    "$rc" "$(grep -F 'Isolation check failed:' "$out_e2e" | head -n 1)"
}

run_control_3_env_guard() {
  local base="$CTRL_SCRATCH/c3-env-guard"
  mkdir -p -- "$base/home" "$base/agent" "$base/cwd" "$base/host/node_modules/@earendil-works" || return 1
  ln -sfn -- "$PI_PKG_DIR" "$base/host/node_modules/@earendil-works/pi-coding-agent" || return 1
  cp -- "$REPO_ROOT/probes/p1/probe-fabric.ts" "$base/host/probe-fabric.ts" || return 1

  printf '\n=== Control 3 (S1): probe-fabric.ts rejects unexpected inherited env var ===\n'

  local out_file="$base/env-guard.log"
  local rc=0
  run_bounded_in_dir 30 "$out_file" "$base/cwd" \
    env -i \
      "PATH=$PATH" \
      "HOME=$base/home" \
      "PI_CODING_AGENT_DIR=$base/agent" \
      "ANTHROPIC_AUTH_TOKEN=dummy-anthropic-auth-token" \
      bun --no-env-file "$base/host/probe-fabric.ts" \
        --scratch "$base" \
        --agent-dir "$base/agent" \
        --cwd "$base/cwd" \
        --pi-package-dir "$PI_PKG_DIR" \
        --label nc-env \
        --expected-version 0.1.0 \
        --expected-package-path "$REPO_ROOT" || rc=$?
  assert_exit_code "$rc" 1 "Control 3 (probe-fabric.ts env allowlist)" "$out_file" || return 1
  assert_contains "$out_file" "Assertion failed: Unexpected inherited environment variables in fixture: ANTHROPIC_AUTH_TOKEN" "Control 3" || return 1
  printf 'probe-fabric.ts with leaked ANTHROPIC_AUTH_TOKEN: exit=%d error=%s\n' \
    "$rc" "$(grep -F 'error: Assertion failed:' "$out_file" | head -n 1)"
}

run_control_4_model_runtime() {
  local base="$CTRL_SCRATCH/c4-model-runtime"
  mkdir -p -- "$base/home" "$base/agent" "$base/cwd" || return 1

  printf '\n=== Control 4 (S1): Pi ModelRuntime detects leaked credentials outside old denylist ===\n'

  local audit_script="$base/audit-model-runtime.mjs"
  cat > "$audit_script" <<'EOF'
import { pathToFileURL } from "node:url";

const [sdkEntry, cwd, agentDir] = process.argv.slice(2);
const sdk = await import(pathToFileURL(sdkEntry).href);
const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
const resourceLoader = new sdk.DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
});
await resourceLoader.reload();
const { session } = await sdk.createAgentSession({
  cwd,
  agentDir,
  resourceLoader,
  settingsManager,
  sessionManager: sdk.SessionManager.inMemory(cwd),
});
try {
  const availableModels = session.modelRuntime.getAvailableSnapshot().length;
  const authProviders = session.modelRuntime
    .getProviders()
    .filter((p) => session.modelRuntime.hasConfiguredAuth(p.id))
    .map((p) => p.id)
    .sort();
  const selectedModel = session.model ? `${session.model.provider}/${session.model.id}` : null;
  console.log(JSON.stringify({ availableModels, authProviders, selectedModel }));
  if (availableModels <= 0 || !authProviders.includes("anthropic") || !authProviders.includes("azure")) {
    process.exit(1);
  }
  if (!selectedModel || selectedModel === "unknown/unknown") {
    process.exit(1);
  }
} finally {
  session.dispose();
}
EOF

  local out_file="$base/model-runtime.log"
  local rc=0
  run_bounded_in_dir 30 "$out_file" "$base/cwd" \
    env -i \
      "PATH=$PATH" \
      "HOME=$base/home" \
      "PI_CODING_AGENT_DIR=$base/agent" \
      "ANTHROPIC_AUTH_TOKEN=dummy-anthropic-auth-token" \
      "AZURE_OPENAI_API_KEY=dummy-azure-openai-key" \
      bun --no-env-file "$audit_script" "$PI_PKG_DIR/dist/index.js" "$base/cwd" "$base/agent" || rc=$?
  assert_exit_code "$rc" 0 "Control 4 (ModelRuntime detection)" "$out_file" || return 1
  assert_contains "$out_file" '"anthropic"' "Control 4" || return 1
  assert_contains "$out_file" '"azure"' "Control 4" || return 1
  printf 'ModelRuntime with leaked dummy credentials: exit=%d output=%s\n' \
    "$rc" "$(tr -d '\r\n' < "$out_file")"
}

run_control_5_protocol_drift() {
  local base="$CTRL_SCRATCH/c5-protocol-drift"
  mkdir -p -- \
    "$base/home" \
    "$base/xdg/config" \
    "$base/xdg/cache" \
    "$base/xdg/data" \
    "$base/xdg/state" \
    "$base/tmp" \
    "$base/agent" \
    "$base/cwd" \
    "$base/pkg/src" \
    "$base/host/node_modules/@earendil-works" || return 1
  ln -sfn -- "$PI_PKG_DIR" "$base/host/node_modules/@earendil-works/pi-coding-agent" || return 1
  cp -- "$REPO_ROOT/probes/p1/probe-fabric.ts" "$base/host/probe-fabric.ts" || return 1
  cp -- "$REPO_ROOT/package.json" "$base/pkg/package.json" || return 1
  cp -- "$REPO_ROOT/src/index.ts" "$base/pkg/src/index.ts" || return 1

  python3 -I - "$base/pkg/src/index.ts" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
old = 'export const FABRIC_PROVIDER_REGISTER_EVENT = "pi-fabric:provider:register:v1";'
new = 'export const FABRIC_PROVIDER_REGISTER_EVENT = "pi-fabric:provider:register:v999";'
if old not in text:
    raise SystemExit("Control 5 setup failed: register constant not found in scratch src/index.ts")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
PY

  printf '\n=== Control 5: probe-fabric.ts fails on pi-fabric protocol event-name drift ===\n'

  local -a env_cmd=(
    env -i
    "PATH=$PATH"
    "HOME=$base/home"
    "XDG_CONFIG_HOME=$base/xdg/config"
    "XDG_CACHE_HOME=$base/xdg/cache"
    "XDG_DATA_HOME=$base/xdg/data"
    "XDG_STATE_HOME=$base/xdg/state"
    "TMPDIR=$base/tmp"
    "LANG=C.UTF-8"
    "LC_ALL=C.UTF-8"
    "GIT_CONFIG_NOSYSTEM=1"
    "GIT_CONFIG_GLOBAL=/dev/null"
    "GIT_TERMINAL_PROMPT=0"
    "PI_CODING_AGENT_DIR=$base/agent"
    "PI_SKIP_VERSION_CHECK=1"
  )
  if [[ -n "$RESOLVED_BUN_INSTALL" ]]; then
    env_cmd+=("BUN_INSTALL=$RESOLVED_BUN_INSTALL")
  fi

  local install_out="$base/install-fabric.log"
  local rc=0
  # shellcheck disable=SC2016 # positional args expand inside inner bash -c
  run_bounded_in_dir 120 "$install_out" "$base/cwd" \
    bash -euo pipefail -c 'source "$1"; SAFE_PATH="$PATH"; RESOLVED_BUN_INSTALL="$2"; PI_PKG_DIR="$3"; run_fixture_cmd "$4" "$5" pi install "$6"' \
    _ "$REPO_ROOT/probes/p1/run.sh" "$RESOLVED_BUN_INSTALL" "$PI_PKG_DIR" "$base/agent" "$base" "$PI_FABRIC_SPEC" || rc=$?
  assert_exit_code "$rc" 0 "Control 5 setup (install pi-fabric)" "$install_out" || return 1
  assert_contains "$install_out" "Resolved Pi getAgentDir()=$base/agent" "Control 5 setup (install pi-fabric)" || return 1
  grep -E '^(Resolved Pi getAgentDir\(\)=|Installing |Installed )' "$install_out" || return 1

  local drift_out="$base/drift.log"
  rc=0
  run_bounded_in_dir 30 "$drift_out" "$base/cwd" "${env_cmd[@]}" \
    bun --no-env-file "$base/host/probe-fabric.ts" \
      --scratch "$base" \
      --agent-dir "$base/agent" \
      --cwd "$base/cwd" \
      --pi-package-dir "$PI_PKG_DIR" \
      --label nc-drift \
      --expected-version 0.1.0 \
      --expected-package-path "$base/pkg" || rc=$?
  assert_exit_code "$rc" 1 "Control 5 (protocol drift check)" "$drift_out" || return 1
  assert_contains "$drift_out" "Assertion failed: FABRIC_PROVIDER_REGISTER_EVENT drift: src/index.ts=pi-fabric:provider:register:v999 vs pi-fabric=pi-fabric:provider:register:v1" "Control 5" || return 1
  printf 'Mutated scratch src/index.ts register constant: exit=%d error=%s\n' \
    "$rc" "$(grep -F 'error: Assertion failed:' "$drift_out" | head -n 1)"
}

main() {
  if (( $# > 0 )); then
    err "probes/p1/run-controls.sh takes no arguments"
    return 2
  fi

  trap 'on_signal 130' INT
  trap 'on_signal 143' TERM
  trap 'on_signal 129' HUP
  trap cleanup EXIT

  CTRL_SCRATCH="$(mktemp -d /tmp/herdr-captain-p1-controls.XXXXXX)" || return 1
  CTRL_SCRATCH="$(realpath -- "$CTRL_SCRATCH")" || return 1
  mkdir -p -- "$CTRL_SCRATCH/cwd" || return 1
  resolve_host_tools "$CTRL_SCRATCH/cwd" || return 1

  run_control_1_dotenv || return $?
  run_control_2_wrapper_failure || return $?
  run_control_3_env_guard || return $?
  run_control_4_model_runtime || return $?
  run_control_5_protocol_drift || return $?

  printf '\nAll 5 Probe P1 controls passed.\n'
}

main "$@"
