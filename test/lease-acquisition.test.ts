import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import {
  acquireLease,
  CONFLICT_EXIT_CODE,
  getGlobalLeaseRegistry,
  isSameProcessAlive,
  LeaseError,
  readOwnerRecord,
  readProcessStat,
} from "../src/lease.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import {
  LEASE_SOURCE_PATH,
  makeFakeFlockScript,
  setupLeaseSuiteHooks,
} from "./helpers/lease-fixtures.ts";
import {
  isLockFreeNonBlocking,
  readFirstLine,
  snapshotFile,
  waitForKernelLockRelease,
} from "./helpers/process.ts";

assertSupportedBunVersion(Bun.version);

let scratchRoot = "";
const suiteTracker = setupLeaseSuiteHooks((dir) => {
  scratchRoot = dir;
});

describe("Rule (a): no stealing, conflict exit code, and owner.lock preservation", () => {
  test("P2 check-1: second owner fails with owner_conflict and leaves owner.json untouched", async () => {
    const stateRoot = path.join(scratchRoot, "check1");
    const projectKey = "0101010101010101";

    const owner1 = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);

    const acquired1 = await owner1.nextEvent();
    expect(acquired1.event).toBe("acquired");
    expect(acquired1.epoch).toBe(1);
    const holderPid = acquired1.holderPid as number;
    const holderStartTime = acquired1.holderStartTime as string;
    expect(isSameProcessAlive(holderPid, holderStartTime)).toBe(true);

    const ownerJsonPath = path.join(stateRoot, "owner.json");
    const before = snapshotFile(ownerJsonPath);

    const attempt2 = await suiteTracker.runTryOnce([
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    expect(attempt2.event.event).toBe("acquire_failed");
    expect(attempt2.event.code).toBe("owner_conflict");
    expect(attempt2.exit.code).toBe(2);

    const after = snapshotFile(ownerJsonPath);
    expect(after.sha256).toBe(before.sha256);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(isSameProcessAlive(holderPid, holderStartTime)).toBe(true);

    owner1.sendLine("write:owner1-proof.txt");
    const wrote = await owner1.nextEvent();
    if (wrote.event === "released" && wrote.reason === "stdin_eof") {
      assert.fail(
        `Command "write:owner1-proof.txt" never reached owner-worker: worker stdin ended before the command arrived (event=${JSON.stringify(wrote)})`,
      );
    }
    expect(wrote.event).toBe("wrote");
    expect(wrote.epoch).toBe(1);
    expect(fs.readFileSync(path.join(stateRoot, "owner1-proof.txt"), "utf8")).toBe("epoch=1\n");

    const exit1 = await owner1.releaseAndWait();
    expect(exit1.code).toBe(0);
    expect(suiteTracker.retireExternalIfDead(holderPid, holderStartTime)).toBe(true);
  });

  test("owner-worker hold mode distinguishes stdin_eof from release_command on final released event", async () => {
    const stateRoot = path.join(scratchRoot, "worker-release-reason");
    const projectKey = "0101010101010102";

    // 1. Closing worker stdin without sending a `release` line reports reason="stdin_eof".
    const eofWorker = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    const acquired1 = await eofWorker.nextEvent();
    expect(acquired1.event).toBe("acquired");
    expect(acquired1.epoch).toBe(1);
    const holder1Pid = acquired1.holderPid as number;
    const holder1Start = acquired1.holderStartTime as string;

    eofWorker.child.stdin?.end();
    const releasedEof = await eofWorker.nextEvent();
    expect(releasedEof.event).toBe("released");
    expect(releasedEof.reason).toBe("stdin_eof");
    expect(releasedEof.epoch).toBe(1);

    const exit1 = await eofWorker.exited;
    expect(exit1.code).toBe(0);
    expect(suiteTracker.retireExternalIfDead(holder1Pid, holder1Start)).toBe(true);

    // 2. Sending an explicit `release` line reports reason="release_command".
    const cmdWorker = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    const acquired2 = await cmdWorker.nextEvent();
    expect(acquired2.event).toBe("acquired");
    expect(acquired2.epoch).toBe(2);
    const holder2Pid = acquired2.holderPid as number;
    const holder2Start = acquired2.holderStartTime as string;

    cmdWorker.sendLine("release");
    const releasedCmd = await cmdWorker.nextEvent();
    expect(releasedCmd.event).toBe("released");
    expect(releasedCmd.reason).toBe("release_command");
    expect(releasedCmd.epoch).toBe(2);

    const exit2 = await cmdWorker.exited;
    expect(exit2.code).toBe(0);
    expect(suiteTracker.retireExternalIfDead(holder2Pid, holder2Start)).toBe(true);
  });

  test("P2 gap-2: raw flock --conflict-exit-code 200 separates conflict from holder failure and missing directory", async () => {
    const lockPath = path.join(scratchRoot, "gap2.lock");
    const holder = suiteTracker.trackChild(
      spawn(
        "flock",
        [
          "--exclusive",
          "--nonblocking",
          "--no-fork",
          lockPath,
          "sh",
          "-c",
          'printf "ready\\n"; exec cat >/dev/null',
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      ),
    );
    assert.ok(holder.child.stdout);
    expect(await readFirstLine(holder.child.stdout)).toBe("ready");

    const defaultConflict = spawnSync("flock", ["--exclusive", "--nonblock", lockPath, "true"]);
    const explicitConflict = spawnSync("flock", [
      "--exclusive",
      "--nonblocking",
      "--conflict-exit-code",
      String(CONFLICT_EXIT_CODE),
      lockPath,
      "true",
    ]);

    holder.child.stdin?.end();
    await holder.exited;

    const defaultHolderFail = spawnSync("flock", [
      "--exclusive",
      "--nonblock",
      lockPath,
      "sh",
      "-c",
      "exit 1",
    ]);
    const explicitHolderFail = spawnSync("flock", [
      "--exclusive",
      "--nonblocking",
      "--conflict-exit-code",
      String(CONFLICT_EXIT_CODE),
      lockPath,
      "sh",
      "-c",
      "exit 1",
    ]);
    const missingDirFail = spawnSync("flock", [
      "--exclusive",
      "--nonblocking",
      "--conflict-exit-code",
      String(CONFLICT_EXIT_CODE),
      path.join(scratchRoot, "missing", "owner.lock"),
      "true",
    ]);

    expect(defaultConflict.status).toBe(1);
    expect(defaultHolderFail.status).toBe(1);
    expect(explicitConflict.status).toBe(CONFLICT_EXIT_CODE);
    expect(explicitHolderFail.status).toBe(1);
    expect(missingDirFail.status).toBe(66);
  });

  test("non-200 exits, bad ready line, and acquire timeout before ready line fail with lease_acquire_error (not owner_conflict)", async () => {
    const cases: Array<{
      name: string;
      script: string;
      acquireTimeoutMs?: number;
      expectedMessage: RegExp;
    }> = [
      {
        name: "exit-1",
        script: 'echo "holder boom" >&2\nexit 1',
        expectedMessage: /Holder exited before ready \(code=1/,
      },
      {
        name: "exit-66",
        script: 'echo "cannot open lock" >&2\nexit 66',
        expectedMessage: /Holder exited before ready \(code=66/,
      },
      {
        name: "exit-0-without-ready",
        script: "exit 0",
        expectedMessage: /Holder exited before ready \(code=0/,
      },
      {
        name: "unexpected-ready-line",
        script: 'printf "not-ready\\n"\nexec cat >/dev/null',
        expectedMessage: /Unexpected holder ready line/,
      },
      {
        name: "acquire-timeout",
        script: "exec cat >/dev/null",
        acquireTimeoutMs: 120,
        expectedMessage: /Timed out waiting for holder ready line/,
      },
    ];

    const originalPath = process.env.PATH ?? "";
    for (const item of cases) {
      const binDir = path.join(scratchRoot, `fake-bin-${item.name}`);
      const stateRoot = path.join(scratchRoot, `state-${item.name}`);
      makeFakeFlockScript(binDir, item.script);

      process.env.PATH = `${binDir}:${originalPath}`;
      try {
        let caught: unknown;
        try {
          await acquireLease({
            projectKey: `a000000000000001`,
            stateRoot,
            acquireTimeoutMs: item.acquireTimeoutMs ?? 2000,
            releaseTimeoutMs: 500,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(LeaseError);
        const leaseErr = caught as LeaseError;
        expect(leaseErr.code).toBe("lease_acquire_error");
        expect(leaseErr.code).not.toBe("owner_conflict");
        expect(leaseErr.message).toMatch(item.expectedMessage);
      } finally {
        process.env.PATH = originalPath;
      }
    }

    // Missing flock binary (ENOENT spawn error) also yields lease_acquire_error.
    const emptyBin = path.join(scratchRoot, "empty-bin");
    fs.mkdirSync(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;
    try {
      let caught: unknown;
      try {
        await acquireLease({
          projectKey: "a000000000000002",
          stateRoot: path.join(scratchRoot, "state-no-flock"),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LeaseError);
      expect((caught as LeaseError).code).toBe("lease_acquire_error");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("owner.lock is never unlinked and src/lease.ts obeys static section 5 boundaries", async () => {
    const stateRoot = path.join(scratchRoot, "lock-inode");
    const projectKey = "a101010101010101";
    const lockPath = path.join(stateRoot, "owner.lock");

    const lease1 = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease1.holderPid, lease1.holderStartTime, "inode-holder-1");
    const ino1 = fs.statSync(lockPath).ino;
    await lease1.release();
    expect(suiteTracker.retireExternalIfDead(lease1.holderPid, lease1.holderStartTime)).toBe(true);

    // owner.lock must still exist with the exact same inode after release.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.statSync(lockPath).ino).toBe(ino1);

    const lease2 = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease2.holderPid, lease2.holderStartTime, "inode-holder-2");
    expect(fs.statSync(lockPath).ino).toBe(ino1);
    expect(lease2.epoch).toBe(2);
    await lease2.release();
    expect(suiteTracker.retireExternalIfDead(lease2.holderPid, lease2.holderStartTime)).toBe(true);
    expect(fs.statSync(lockPath).ino).toBe(ino1);

    // Boundary check on src/lease.ts: only node:* imports, no git, no kill(pid, 0), no unlink of owner.lock.
    const source = fs.readFileSync(LEASE_SOURCE_PATH, "utf8");
    const importSpecs = [...source.matchAll(/^\s*import\s+[^;]*?\s+from\s+["']([^"']+)["'];/gm)].map(
      (m) => m[1],
    );
    expect(importSpecs.length).toBeGreaterThan(0);
    for (const spec of importSpecs) {
      expect(spec?.startsWith("node:")).toBe(true);
    }
    expect(source).not.toMatch(/\bgit\b/);
    expect(source).not.toMatch(/\.kill\([^,]+,\s*0\s*\)/);
    expect(source).not.toMatch(/unlink(?:Sync)?\([^)]*lockPath|rm(?:Sync)?\([^)]*lockPath/);
  });
});

describe("Rule (b): --no-fork holder identity, atomic fencing epoch, and post-ready failure cleanup", () => {
  test("P2 gap-1: default flock forks two PIDs whose lock survives SIGKILL(flock), while --no-fork keeps one PID", async () => {
    const lockDefault = path.join(scratchRoot, "gap1-default.lock");
    const fifoDefault = path.join(scratchRoot, "gap1-default.fifo");
    const lockNoFork = path.join(scratchRoot, "gap1-nofork.lock");
    const fifoNoFork = path.join(scratchRoot, "gap1-nofork.fifo");

    execFileSync("mkfifo", [fifoDefault]);
    execFileSync("mkfifo", [fifoNoFork]);

    const writerDefault = suiteTracker.trackChild(
      spawn("sh", ["-c", 'exec cat > "$1"', "_", fifoDefault], {
        stdio: ["pipe", "ignore", "ignore"],
      }),
    );

    const flockDefault = suiteTracker.trackChild(
      spawn(
        "sh",
        [
          "-c",
          'exec flock --exclusive --nonblock "$1" sh -c \'printf "%d\\n" "$$"; exec cat >/dev/null\' < "$2"',
          "_",
          lockDefault,
          fifoDefault,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    );

    assert.ok(flockDefault.child.stdout);
    const innerPidDefault = Number(await readFirstLine(flockDefault.child.stdout));
    const innerStartTime = readProcessStat(innerPidDefault)?.startTime ?? null;
    assert.ok(innerStartTime !== null);
    suiteTracker.trackExternal(innerPidDefault, innerStartTime, "orphaned-inner-holder");
    expect(flockDefault.pid).not.toBe(innerPidDefault);

    await flockDefault.ensureStopped();

    expect(isSameProcessAlive(innerPidDefault, innerStartTime)).toBe(true);
    expect(isLockFreeNonBlocking(lockDefault)).toBe(false);

    writerDefault.child.stdin?.end();
    await writerDefault.exited;
    await waitForKernelLockRelease(lockDefault, 5, suiteTracker);
    expect(suiteTracker.retireExternalIfDead(innerPidDefault, innerStartTime)).toBe(true);

    // With --no-fork: single PID, SIGKILL releases the lock immediately even while pipe stays open.
    const writerNoFork = suiteTracker.trackChild(
      spawn("sh", ["-c", 'exec cat > "$1"', "_", fifoNoFork], {
        stdio: ["pipe", "ignore", "ignore"],
      }),
    );
    const flockNoFork = suiteTracker.trackChild(
      spawn(
        "sh",
        [
          "-c",
          'exec flock --exclusive --nonblocking --no-fork "$1" sh -c \'printf "%d\\n" "$$"; exec cat >/dev/null\' < "$2"',
          "_",
          lockNoFork,
          fifoNoFork,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    );

    assert.ok(flockNoFork.child.stdout);
    const innerPidNoFork = Number(await readFirstLine(flockNoFork.child.stdout));
    expect(flockNoFork.pid).toBe(innerPidNoFork);

    await flockNoFork.ensureStopped();
    expect(isLockFreeNonBlocking(lockNoFork)).toBe(true);

    writerNoFork.child.stdin?.end();
    await writerNoFork.exited;
  });

  test("acquireLease holderPid is the lock holder itself (SIGKILL on holderPid immediately frees owner.lock)", async () => {
    const stateRoot = path.join(scratchRoot, "nofork-direct");
    const projectKey = "b101010101010101";
    const lockPath = path.join(stateRoot, "owner.lock");

    const lease = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "direct-holder");
    expect(isLockFreeNonBlocking(lockPath)).toBe(false);

    process.kill(lease.holderPid, "SIGKILL");
    await waitForKernelLockRelease(lockPath, 5, suiteTracker);
    expect(isLockFreeNonBlocking(lockPath)).toBe(true);
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
    await lease.release();
  });

  test("P2 check-2: SIGKILL owner closes pipe, holder exits, kernel lock releases, new owner acquires epoch 2", async () => {
    const stateRoot = path.join(scratchRoot, "check2");
    const projectKey = "0202020202020202";
    const lockPath = path.join(stateRoot, "owner.lock");

    const owner1 = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    const acquired1 = await owner1.nextEvent();
    expect(acquired1.event).toBe("acquired");
    expect(acquired1.epoch).toBe(1);
    assert.ok(typeof owner1.pid === "number");
    const owner1Start = readProcessStat(owner1.pid)?.startTime;
    assert.ok(owner1Start);
    expect(isSameProcessAlive(owner1.pid, owner1Start)).toBe(true);
    const holder1Pid = acquired1.holderPid as number;
    const holder1Start = acquired1.holderStartTime as string;
    expect(isSameProcessAlive(holder1Pid, holder1Start)).toBe(true);

    process.kill(owner1.pid, "SIGKILL");
    const exit1 = await owner1.exited;
    expect(exit1.signal).toBe("SIGKILL");

    await waitForKernelLockRelease(lockPath, 5, suiteTracker);
    expect(suiteTracker.retireExternalIfDead(holder1Pid, holder1Start)).toBe(true);

    const owner2 = suiteTracker.spawnWorker([
      "--mode",
      "hold",
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    const acquired2 = await owner2.nextEvent();
    expect(acquired2.event).toBe("acquired");
    expect(acquired2.epoch).toBe(2);
    expect(acquired2.holderPid).not.toBe(holder1Pid);

    const diskOwner = readOwnerRecord(stateRoot);
    expect(diskOwner?.epoch).toBe(2);
    expect(diskOwner?.pid).toBe(owner2.pid);
    expect(diskOwner?.holderPid).toBe(acquired2.holderPid);

    const attempt3 = await suiteTracker.runTryOnce([
      "--state-root",
      stateRoot,
      "--project-key",
      projectKey,
    ]);
    expect(attempt3.event.code).toBe("owner_conflict");
    expect(attempt3.exit.code).toBe(2);

    const exit2 = await owner2.releaseAndWait();
    expect(exit2.code).toBe(0);
    expect(
      suiteTracker.retireExternalIfDead(
        acquired2.holderPid as number,
        acquired2.holderStartTime as string,
      ),
    ).toBe(true);
  });

  test("failure to read, check, or write owner.json after ready line closes stdin, awaits holder exit, and frees owner.lock", async () => {
    const projectKey = "b202020202020202";

    // Helper that observes the real spawned holder's PID & startTime right after ready line
    // and asserts acquireLease awaited that exact holder's exit before throwing.
    const expectAcquireRejectsAndAwaitsHolderExit = async (
      stateRoot: string,
      checkRejection: (err: unknown) => void,
      overrideStat?: string | Error,
    ): Promise<void> => {
      let observedHolderPid: number | null = null;
      let observedHolderStart: string | null = null;
      const origReadFileSync = fs.readFileSync.bind(fs);
      const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
        const filePath = String(args[0]);
        const match = filePath.match(/^\/proc\/(\d+)\/stat$/);
        if (match && observedHolderPid === null) {
          const pid = Number(match[1]);
          const realStat = origReadFileSync(filePath, "utf8");
          const closeParen = realStat.lastIndexOf(")");
          const fields = realStat.slice(closeParen + 2).trim().split(/\s+/);
          observedHolderPid = pid;
          observedHolderStart = fields[19] ?? null;
          if (overrideStat instanceof Error) {
            throw overrideStat;
          }
          if (typeof overrideStat === "string") {
            return overrideStat;
          }
          return realStat;
        }
        return (origReadFileSync as (...a: unknown[]) => unknown)(...args);
      }) as typeof fs.readFileSync);

      let caught: unknown = undefined;
      let threw = false;
      try {
        await acquireLease({ projectKey, stateRoot });
      } catch (err) {
        threw = true;
        caught = err;
      } finally {
        spy.mockRestore();
        if (observedHolderPid !== null && observedHolderStart !== null) {
          suiteTracker.trackExternal(observedHolderPid, observedHolderStart, "post-ready-holder");
        }
      }

      expect(threw).toBe(true);
      checkRejection(caught);
      assert.ok(observedHolderPid !== null && observedHolderStart !== null);
      expect(suiteTracker.retireExternalIfDead(observedHolderPid, observedHolderStart)).toBe(true);
      expect(isLockFreeNonBlocking(path.join(stateRoot, "owner.lock"))).toBe(true);
      expect(getGlobalLeaseRegistry().has(projectKey)).toBe(false);
    };

    // 1. Read failure: owner.json is a directory (EISDIR).
    {
      const stateRoot = path.join(scratchRoot, "post-ready-eisdir");
      fs.mkdirSync(path.join(stateRoot, "owner.json"), { recursive: true });
      await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
        expect(err).toBeInstanceOf(Error);
      });
    }

    // 2. Read failure: malformed owner.json.
    {
      const stateRoot = path.join(scratchRoot, "post-ready-malformed");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(path.join(stateRoot, "owner.json"), "{not-json", "utf8");
      await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
        expect(err).toBeInstanceOf(LeaseError);
        expect((err as LeaseError).code).toBe("identity_mismatch");
      });
    }

    // 3. Check failure: projectKey mismatch in owner.json.
    {
      const stateRoot = path.join(scratchRoot, "post-ready-key-mismatch");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(
        path.join(stateRoot, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          projectKey: "ffffffffffffffff",
          epoch: 1,
          pid: process.pid,
          holderPid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
        expect(err).toBeInstanceOf(LeaseError);
        expect((err as LeaseError).code).toBe("identity_mismatch");
      });
    }

    // 4. Check failure (weakness 2): non-safe-integer or invalid epochs fail closed in both readOwnerRecord and acquireLease.
    const badEpochs: unknown[] = [
      Number.MAX_SAFE_INTEGER + 1,
      1e20,
      1.5,
      0,
      -1,
      "1",
      null,
    ];
    for (let i = 0; i < badEpochs.length; i += 1) {
      const stateRoot = path.join(scratchRoot, `post-ready-bad-epoch-${i}`);
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(
        path.join(stateRoot, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          projectKey,
          epoch: badEpochs[i],
          pid: process.pid,
          holderPid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      expect(() => readOwnerRecord(stateRoot)).toThrow(LeaseError);
      try {
        readOwnerRecord(stateRoot);
      } catch (err) {
        expect((err as LeaseError).code).toBe("identity_mismatch");
      }
      await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
        expect(err).toBeInstanceOf(LeaseError);
        expect((err as LeaseError).code).toBe("identity_mismatch");
      });
    }

    // 5. Check failure (weakness 2 overflow): epoch === Number.MAX_SAFE_INTEGER cannot safely increment.
    {
      const stateRoot = path.join(scratchRoot, "post-ready-max-safe-epoch");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(
        path.join(stateRoot, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          projectKey,
          epoch: Number.MAX_SAFE_INTEGER,
          pid: process.pid,
          holderPid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      expect(readOwnerRecord(stateRoot)?.epoch).toBe(Number.MAX_SAFE_INTEGER);
      await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
        expect(err).toBeInstanceOf(LeaseError);
        expect((err as LeaseError).code).toBe("identity_mismatch");
      });
    }

    // 6. Check failure (weakness 1 at acquire): truncated /proc/<holderPid>/stat (missing starttime) fails closed and frees lock.
    {
      const stateRoot = path.join(scratchRoot, "post-ready-missing-starttime");
      await expectAcquireRejectsAndAwaitsHolderExit(
        stateRoot,
        (err) => {
          expect(err).toBeInstanceOf(LeaseError);
          expect((err as LeaseError).code).toBe("lease_acquire_error");
          expect((err as LeaseError).message).toMatch(/verify live holder identity/);
        },
        "99999 (cat) S 1 1 1\n",
      );
    }

    // 7. Write failure: injected renameSync error after ready line cleans temp file, awaits holder exit, and frees lock.
    {
      const stateRoot = path.join(scratchRoot, "post-ready-write-rename-fail");
      fs.mkdirSync(stateRoot, { recursive: true });
      const origRename = fs.renameSync.bind(fs);
      const renameSpy = spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
        if (String(newPath) === path.join(stateRoot, "owner.json")) {
          const eio = Object.assign(new Error("forced EIO on owner.json rename"), { code: "EIO" });
          throw eio;
        }
        return origRename(oldPath, newPath);
      });
      try {
        await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
          expect(err).toBeInstanceOf(Error);
          expect((err as Error).message).toMatch(/forced EIO/);
        });
      } finally {
        renameSpy.mockRestore();
      }
      const leftoverTemps = fs
        .readdirSync(stateRoot)
        .filter((name) => name.startsWith(".owner.json.tmp."));
      expect(leftoverTemps).toEqual([]);
    }

    // 8. Write failure on read-only stateRoot (non-root): pre-created owner.lock succeeds, owner.json write fails EACCES.
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const stateRoot = path.join(scratchRoot, "post-ready-readonly-dir");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.writeFileSync(path.join(stateRoot, "owner.lock"), "", "utf8");
      fs.chmodSync(stateRoot, 0o555);
      try {
        await expectAcquireRejectsAndAwaitsHolderExit(stateRoot, (err) => {
          expect(err).toBeInstanceOf(Error);
        });
      } finally {
        fs.chmodSync(stateRoot, 0o755);
      }
    }
  });

  test("P2 ctrl-5a (Part 2): /proc stat failure after ready line closes stdin, awaits holder exit, and frees owner.lock", async () => {
    const stateRoot = path.join(scratchRoot, "ctrl5a-lease");
    const projectKey = "0505050505050502";
    const lockPath = path.join(stateRoot, "owner.lock");

    let observedHolderPid: number | null = null;
    let observedHolderStart: string | null = null;
    const origReadFileSync = fs.readFileSync.bind(fs);

    const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      const filePath = String(args[0]);
      const match = filePath.match(/^\/proc\/(\d+)\/stat$/);
      if (match && observedHolderPid === null) {
        const pid = Number(match[1]);
        const realStat = origReadFileSync(filePath, "utf8");
        const closeParen = realStat.lastIndexOf(")");
        const fields = realStat.slice(closeParen + 2).trim().split(/\s+/);
        observedHolderPid = pid;
        observedHolderStart = fields[19] ?? null;
        throw Object.assign(new Error("forced_post_acquire_readProcessStat_error"), {
          code: "EACCES",
        });
      }
      return (origReadFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.readFileSync);

    try {
      await expect(acquireLease({ projectKey, stateRoot })).rejects.toMatchObject({
        name: "LeaseError",
        code: "lease_acquire_error",
        message: "Failed to read holder /proc stat",
        details: { cause: "forced_post_acquire_readProcessStat_error" },
      });
    } finally {
      spy.mockRestore();
      if (observedHolderPid !== null && observedHolderStart !== null) {
        suiteTracker.trackExternal(observedHolderPid, observedHolderStart, "ctrl5a-holder");
      }
    }

    assert.ok(observedHolderPid !== null && observedHolderStart !== null);
    expect(suiteTracker.retireExternalIfDead(observedHolderPid, observedHolderStart)).toBe(true);
    expect(isLockFreeNonBlocking(lockPath)).toBe(true);
    expect(getGlobalLeaseRegistry().has(projectKey)).toBe(false);
  });

  test("returned lease.ownerRecord is immutable so external mutation cannot corrupt localEpoch", async () => {
    const stateRoot = path.join(scratchRoot, "frozen-record");
    const projectKey = "b303030303030303";
    const lease = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "frozen-holder");

    expect(Object.isFrozen(lease.ownerRecord)).toBe(true);
    expect(() => {
      (lease.ownerRecord as { epoch: number }).epoch = 999;
    }).toThrow(TypeError);
    expect(lease.ownerRecord.epoch).toBe(1);
    lease.assertValid();

    await lease.release();
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
  });
});
