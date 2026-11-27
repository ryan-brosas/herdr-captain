#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly REPO_ROOT
readonly PI_FABRIC_SPEC="npm:pi-fabric@0.140.1"
readonly GITHUB_REPO_PREFIX="git:github.com/ryan-brosas/herdr-captain"

SCRATCH=""
PI_PKG_DIR=""

err() {
  printf 'probe-p1 error: %s\n' "$*" >&2
}

cleanup() {
  if [[ -n "$SCRATCH" && -d "$SCRATCH" ]]; then
    rm -rf -- "$SCRATCH"
  fi
}

usage() {
  cat <<'EOF'
Usage: probes/p1/run.sh [--offline-only] [--git-sha <40-hex-sha>]

Options:
  --offline-only      Run only local-path install checks (Checks 1 and 2; zero network).
  --git-sha <sha>     Run Check 5 against git:github.com/ryan-brosas/herdr-captain@<sha>
                      (and verify the Fabric provider seam on the cloned package).
  -h, --help          Show this help text.
EOF
}

resolve_pi_coding_agent_dir() {
  if [[ -n "${PI_CODING_AGENT_PACKAGE_DIR:-}" && -f "${PI_CODING_AGENT_PACKAGE_DIR}/package.json" ]]; then
    realpath -- "${PI_CODING_AGENT_PACKAGE_DIR}"
    return 0
  fi

  local bun_bin_dir
  if command -v bun >/dev/null 2>&1; then
    bun_bin_dir="$(bun pm bin -g 2>/dev/null || true)"
    if [[ -n "$bun_bin_dir" && -e "$bun_bin_dir/pi" ]]; then
      local pi_real
      pi_real="$(realpath -- "$bun_bin_dir/pi")"
      local dir
      dir="$(dirname -- "$pi_real")"
      while [[ "$dir" != "/" ]]; do
        if [[ -f "$dir/package.json" ]] && grep -q '"name"[[:space:]]*:[[:space:]]*"@earendil-works/pi-coding-agent"' "$dir/package.json"; then
          printf '%s\n' "$dir"
          return 0
        fi
        dir="$(dirname -- "$dir")"
      done
    fi
  fi

  local npm_root
  if command -v npm >/dev/null 2>&1; then
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -n "$npm_root" && -f "$npm_root/@earendil-works/pi-coding-agent/package.json" ]]; then
      realpath -- "$npm_root/@earendil-works/pi-coding-agent"
      return 0
    fi
  fi

  err "Could not locate @earendil-works/pi-coding-agent; set PI_CODING_AGENT_PACKAGE_DIR"
  return 1
}

read_package_version() {
  local pkg_json="$1"
  bun -e 'const p = JSON.parse(await Bun.file(process.argv[1]).text()); if (!p.version) process.exit(1); console.log(p.version);' "$pkg_json"
}

assert_isolated_agent_dir() {
  local agent_dir="$1"
  local scratch_real="$2"
  mkdir -p -- "$agent_dir"

  local resolved_agent_dir
  resolved_agent_dir="$(realpath -- "$agent_dir")"
  local pi_agent_dir
  pi_agent_dir="$(
    PI_CODING_AGENT_DIR="$resolved_agent_dir" bun -e '
      import { pathToFileURL } from "node:url";
      const mod = await import(pathToFileURL(process.argv[1]).href);
      console.log(mod.getAgentDir());
    ' "$PI_PKG_DIR/dist/config.js"
  )"
  local resolved_pi_agent_dir
  resolved_pi_agent_dir="$(realpath -- "$pi_agent_dir")"
  printf 'Resolved Pi getAgentDir()=%s\n' "$resolved_pi_agent_dir"

  if [[ "$resolved_pi_agent_dir" != "$resolved_agent_dir" ]]; then
    err "Isolation check failed: Pi getAgentDir() ($resolved_pi_agent_dir) !== expected ($resolved_agent_dir)"
    return 1
  fi
  if [[ "$resolved_pi_agent_dir" != "$scratch_real/"* ]]; then
    err "Isolation check failed: $resolved_pi_agent_dir is outside $scratch_real"
    return 1
  fi
  if [[ -e "$resolved_pi_agent_dir/auth.json" ]]; then
    err "Isolation check failed: fixture must not contain auth.json"
    return 1
  fi
}

run_fixture_cmd() {
  local agent_dir="$1"
  local scratch_real="$2"
  shift 2

  assert_isolated_agent_dir "$agent_dir" "$scratch_real"
  local resolved_agent_dir
  resolved_agent_dir="$(realpath -- "$agent_dir")"

  local -a clean_env=(
    env
    -u ANTHROPIC_API_KEY
    -u OPENAI_API_KEY
    -u GEMINI_API_KEY
    -u GOOGLE_API_KEY
    -u OPENROUTER_API_KEY
    -u XAI_API_KEY
    -u GROQ_API_KEY
    -u MISTRAL_API_KEY
    -u DEEPSEEK_API_KEY
    -u TOGETHER_API_KEY
    -u FIREWORKS_API_KEY
    -u COHERE_API_KEY
    "PI_CODING_AGENT_DIR=$resolved_agent_dir"
    "PI_SKIP_VERSION_CHECK=1"
  )
  "${clean_env[@]}" "$@"
}

setup_probe_host() {
  local scratch_real="$1"
  local pi_pkg_dir="$2"
  local host_dir="$scratch_real/probe-host"

  mkdir -p -- "$host_dir/node_modules/@earendil-works"
  ln -sfn -- "$pi_pkg_dir" "$host_dir/node_modules/@earendil-works/pi-coding-agent"
  cp -- "$SCRIPT_DIR/probe-fabric.ts" "$host_dir/probe-fabric.ts"
  printf '%s\n' "$host_dir/probe-fabric.ts"
}

run_check_1_local_install() {
  local scratch_real="$1"
  local agent_dir="$scratch_real/agent-local"

  printf '\n=== Check 1: Local-path install ===\n'
  run_fixture_cmd "$agent_dir" "$scratch_real" pi install "$REPO_ROOT"
  if [[ ! -f "$agent_dir/settings.json" ]]; then
    err "Check 1 failed: expected $agent_dir/settings.json to be written"
    return 1
  fi
  local list_output
  list_output="$(run_fixture_cmd "$agent_dir" "$scratch_real" pi list)"
  printf '%s\n' "$list_output"
  if [[ "$list_output" != *"$REPO_ROOT"* ]]; then
    err "Check 1 failed: pi list did not include $REPO_ROOT"
    return 1
  fi
}

run_check_2_offline_install() {
  local scratch_real="$1"
  local agent_dir="$scratch_real/agent-offline"

  printf '\n=== Check 2: Offline local-path install (unshare -rn) ===\n'
  assert_isolated_agent_dir "$agent_dir" "$scratch_real"
  local resolved_agent_dir
  resolved_agent_dir="$(realpath -- "$agent_dir")"

  if ! command -v unshare >/dev/null 2>&1; then
    err "Check 2 failed: unshare command not found"
    return 1
  fi

  local -a clean_env=(
    env
    -u ANTHROPIC_API_KEY
    -u OPENAI_API_KEY
    -u GEMINI_API_KEY
    -u GOOGLE_API_KEY
    -u OPENROUTER_API_KEY
    -u XAI_API_KEY
    -u GROQ_API_KEY
    -u MISTRAL_API_KEY
    -u DEEPSEEK_API_KEY
    -u TOGETHER_API_KEY
    -u FIREWORKS_API_KEY
    -u COHERE_API_KEY
    "PI_CODING_AGENT_DIR=$resolved_agent_dir"
    "PI_SKIP_VERSION_CHECK=1"
  )

  if command -v ip >/dev/null 2>&1; then
    unshare -rn -- ip -brief link show
  fi
  unshare -rn -- bun -e '
    try {
      await fetch("https://registry.npmjs.org/", { signal: AbortSignal.timeout(3000) });
      process.exit(1);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : String(error);
      console.log("Offline namespace negative control blocked network: " + String(code));
    }
  '
  unshare -rn -- "${clean_env[@]}" pi install "$REPO_ROOT"
  if [[ ! -f "$agent_dir/settings.json" ]]; then
    err "Check 2 failed: expected $agent_dir/settings.json to be written"
    return 1
  fi
  local list_output
  list_output="$(unshare -rn -- "${clean_env[@]}" pi list)"
  printf '%s\n' "$list_output"
  if [[ "$list_output" != *"$REPO_ROOT"* ]]; then
    err "Check 2 failed: offline pi list did not include $REPO_ROOT"
    return 1
  fi
}

run_checks_3_and_4_fabric_seam() {
  local scratch_real="$1"
  local probe_entry="$2"
  local pkg_version="$3"
  local fixture_cwd="$scratch_real/cwd"
  mkdir -p -- "$fixture_cwd"

  printf '\n=== Checks 3 & 4 (Order A: pi-fabric@0.140.1 first, herdr-captain second) ===\n'
  local agent_a="$scratch_real/agent-fabric-first"
  run_fixture_cmd "$agent_a" "$scratch_real" pi install "$PI_FABRIC_SPEC"
  run_fixture_cmd "$agent_a" "$scratch_real" pi install "$REPO_ROOT"
  run_fixture_cmd "$agent_a" "$scratch_real" pi list
  run_fixture_cmd "$agent_a" "$scratch_real" bun "$probe_entry" \
    --scratch "$scratch_real" \
    --agent-dir "$agent_a" \
    --cwd "$fixture_cwd" \
    --label "fabric-first" \
    --expected-version "$pkg_version" \
    --expected-package-path "$REPO_ROOT"

  printf '\n=== Checks 3 & 4 (Order B: herdr-captain first, pi-fabric@0.140.1 second) ===\n'
  local agent_b="$scratch_real/agent-captain-first"
  run_fixture_cmd "$agent_b" "$scratch_real" pi install "$REPO_ROOT"
  run_fixture_cmd "$agent_b" "$scratch_real" pi install "$PI_FABRIC_SPEC"
  run_fixture_cmd "$agent_b" "$scratch_real" pi list
  run_fixture_cmd "$agent_b" "$scratch_real" bun "$probe_entry" \
    --scratch "$scratch_real" \
    --agent-dir "$agent_b" \
    --cwd "$fixture_cwd" \
    --label "captain-first" \
    --expected-version "$pkg_version" \
    --expected-package-path "$REPO_ROOT"
}

run_check_5_pinned_git() {
  local scratch_real="$1"
  local probe_entry="$2"
  local pkg_version="$3"
  local git_sha="$4"
  local agent_git="$scratch_real/agent-git"
  local fixture_cwd="$scratch_real/cwd-git"
  local git_spec="${GITHUB_REPO_PREFIX}@${git_sha}"
  mkdir -p -- "$fixture_cwd"

  printf '\n=== Check 5: Pinned git install (%s) ===\n' "$git_spec"
  run_fixture_cmd "$agent_git" "$scratch_real" pi install "$PI_FABRIC_SPEC"
  run_fixture_cmd "$agent_git" "$scratch_real" pi install "$git_spec"
  local list_output
  list_output="$(run_fixture_cmd "$agent_git" "$scratch_real" pi list)"
  printf '%s\n' "$list_output"
  if [[ "$list_output" != *"$git_spec"* ]]; then
    err "Check 5 failed: pi list did not include $git_spec"
    return 1
  fi

  local clone_dir="$agent_git/git/github.com/ryan-brosas/herdr-captain"
  if [[ ! -d "$clone_dir/.git" ]]; then
    err "Check 5 failed: expected git checkout at $clone_dir"
    return 1
  fi
  local checked_out_sha
  checked_out_sha="$(git -C "$clone_dir" rev-parse HEAD)"
  printf 'Checked out git SHA=%s\n' "$checked_out_sha"
  if [[ "$checked_out_sha" != "$git_sha" ]]; then
    err "Check 5 failed: checked out SHA $checked_out_sha !== requested $git_sha"
    return 1
  fi

  run_fixture_cmd "$agent_git" "$scratch_real" bun "$probe_entry" \
    --scratch "$scratch_real" \
    --agent-dir "$agent_git" \
    --cwd "$fixture_cwd" \
    --label "pinned-git" \
    --expected-version "$pkg_version" \
    --expected-package-path "$clone_dir"
}

main() {
  local offline_only=0
  local git_sha=""

  while (( $# > 0 )); do
    case "$1" in
      --offline-only)
        offline_only=1
        shift
        ;;
      --git-sha)
        if (( $# < 2 )); then
          err "--git-sha requires a 40-character commit SHA"
          return 2
        fi
        git_sha="$2"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        err "Unknown option: $1"
        usage >&2
        return 2
        ;;
    esac
  done

  if [[ -n "$git_sha" && "$offline_only" -eq 1 ]]; then
    err "--offline-only cannot be combined with --git-sha"
    return 2
  fi
  if [[ -n "$git_sha" && ! "$git_sha" =~ ^[0-9a-f]{40}$ ]]; then
    err "--git-sha must be a full 40-character lowercase hex commit SHA"
    return 2
  fi

  trap cleanup EXIT
  SCRATCH="$(mktemp -d /tmp/herdr-captain-p1.XXXXXX)"
  local scratch_real
  scratch_real="$(realpath -- "$SCRATCH")"
  PI_PKG_DIR="$(resolve_pi_coding_agent_dir)"

  local pkg_version
  pkg_version="$(read_package_version "$REPO_ROOT/package.json")"
  printf 'herdr-captain version=%s\n' "$pkg_version"

  if [[ -n "$git_sha" ]]; then
    local probe_entry
    probe_entry="$(setup_probe_host "$scratch_real" "$PI_PKG_DIR")"
    run_check_5_pinned_git "$scratch_real" "$probe_entry" "$pkg_version" "$git_sha"
    return 0
  fi

  run_check_1_local_install "$scratch_real"
  run_check_2_offline_install "$scratch_real"

  if (( offline_only == 1 )); then
    printf '\nOffline-only mode complete (Checks 1 and 2 passed).\n'
    return 0
  fi

  local probe_entry
  probe_entry="$(setup_probe_host "$scratch_real" "$PI_PKG_DIR")"
  run_checks_3_and_4_fabric_seam "$scratch_real" "$probe_entry" "$pkg_version"
  printf '\nAll Probe P1 local checks (1-4) passed.\n'
}

main "$@"
