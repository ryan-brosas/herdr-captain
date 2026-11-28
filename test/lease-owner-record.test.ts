import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  acquireLease,
  getGlobalLeaseRegistry,
  readOwnerRecord,
  type OwnerLease,
} from "../src/lease.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import {
  inspectFds,
  isLockFreeNonBlocking,
  ProcessTracker,
  snapshotFile,
} from "./helpers/process.ts";

assertSupportedBunVersion(Bun.version);

const suiteTracker = new ProcessTracker();
let scratchRoot = "";

beforeEach(() => {
  scratchRoot = suiteTracker.createScratchDir("herdr-captain-owner-record-");
});

afterEach(async () => {
  const registry = getGlobalLeaseRegistry();
  for (const [, entry] of [...registry.entries()]) {
    try {
      await entry.revokeAndClose();
    } catch {
      // Best-effort cleanup before strict tracker verification.
    }
  }
  registry.clear();
  await suiteTracker.cleanupAll();
  expect(suiteTracker.ownedChildren.size).toBe(0);
  expect(suiteTracker.trackedExternals.size).toBe(0);
  expect(suiteTracker.activeEnvTokens.size).toBe(0);
  expect(suiteTracker.scratchDirs.size).toBe(0);
});

afterAll(() => {
  suiteTracker.dispose();
});

function getErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

function hasOpenFdForPath(realTargetPath: string): boolean {
  return inspectFds("self").some(
    (entry) =>
      entry.target === realTargetPath || entry.target.startsWith(`${realTargetPath} (`),
  );
}

interface FailedAcquireObservation {
  threw: boolean;
  caught: unknown;
  holderPid: number | null;
  holderStartTime: string | null;
}

async function runAcquireCapturingHolder(
  projectKey: string,
  stateRoot: string,
  label: string,
): Promise<FailedAcquireObservation> {
  let observedHolderPid: number | null = null;
  let observedHolderStart: string | null = null;
  const origReadFileSync = fs.readFileSync.bind(fs);
  const statSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
    const filePath = String(args[0]);
    const match = filePath.match(/^\/proc\/(\d+)\/stat$/);
    if (match && observedHolderPid === null) {
      const pid = Number(match[1]);
      const realStat = origReadFileSync(filePath, "utf8");
      const closeParen = realStat.lastIndexOf(")");
      const fields = realStat.slice(closeParen + 2).trim().split(/\s+/);
      observedHolderPid = pid;
      observedHolderStart = fields[19] ?? null;
      return realStat;
    }
    return (origReadFileSync as (...a: unknown[]) => unknown)(...args);
  }) as typeof fs.readFileSync);

  let lease: OwnerLease | null = null;
  let threw = false;
  let caught: unknown = undefined;

  try {
    lease = await acquireLease({ projectKey, stateRoot });
  } catch (err: unknown) {
    threw = true;
    caught = err;
  } finally {
    statSpy.mockRestore();
    if (lease !== null) {
      observedHolderPid = lease.holderPid;
      observedHolderStart = lease.holderStartTime;
      suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, label);
      await lease.release();
    } else if (observedHolderPid !== null && observedHolderStart !== null) {
      suiteTracker.trackExternal(observedHolderPid, observedHolderStart, label);
    }
  }

  return {
    threw,
    caught,
    holderPid: observedHolderPid,
    holderStartTime: observedHolderStart,
  };
}

function spyNextSixRandomBytes(fixedBytes: Buffer): {
  getCallCount: () => number;
  restore: () => void;
} {
  assert.equal(fixedBytes.length, 6, "fixedBytes must be exactly 6 bytes");
  let callCount = 0;
  const origRandomBytes = crypto.randomBytes.bind(crypto);
  const spy = spyOn(crypto, "randomBytes").mockImplementation(((
    size: number,
    callback?: (err: Error | null, buf: Buffer) => void,
  ) => {
    if (size === 6 && callback === undefined) {
      callCount += 1;
      return Buffer.from(fixedBytes);
    }
    return (origRandomBytes as (...args: unknown[]) => unknown)(
      size,
      ...(callback === undefined ? [] : [callback]),
    );
  }) as typeof crypto.randomBytes);

  return {
    getCallCount: () => callCount,
    restore: () => spy.mockRestore(),
  };
}

describe("Owner-record atomic write temporary file ownership", () => {
  test("failed exclusive creation (EEXIST) preserves a pre-existing file at the chosen temporary path", async () => {
    const stateRoot = path.join(scratchRoot, "eexist-preserves-foreign-temp");
    const projectKey = "4400000000000001";
    fs.mkdirSync(stateRoot, { recursive: true });

    const fixedBytes = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    const collidingTmpName = `.owner.json.tmp.${process.pid}.112233445566`;
    const collidingTmpPath = path.join(stateRoot, collidingTmpName);
    const sentinelBytes = Buffer.from([
      0x66, 0x6f, 0x72, 0x65, 0x69, 0x67, 0x6e, 0x2d, 0x74, 0x65, 0x6d, 0x70, 0x00, 0xff, 0x0a,
    ]);

    fs.writeFileSync(collidingTmpPath, sentinelBytes, { mode: 0o600 });
    const beforeIno = fs.statSync(collidingTmpPath).ino;

    const randomSpy = spyNextSixRandomBytes(fixedBytes);
    let obs: FailedAcquireObservation;
    try {
      obs = await runAcquireCapturingHolder(projectKey, stateRoot, "eexist-holder");
    } finally {
      randomSpy.restore();
    }

    expect(randomSpy.getCallCount()).toBe(1);
    expect(obs.threw).toBe(true);
    expect(obs.caught).toBeInstanceOf(Error);
    expect(getErrorCode(obs.caught)).toBe("EEXIST");

    assert.ok(obs.holderPid !== null && obs.holderStartTime !== null);
    expect(suiteTracker.retireExternalIfDead(obs.holderPid, obs.holderStartTime)).toBe(true);
    expect(isLockFreeNonBlocking(path.join(stateRoot, "owner.lock"))).toBe(true);
    expect(getGlobalLeaseRegistry().has(projectKey)).toBe(false);
    expect(readOwnerRecord(stateRoot)).toBeNull();

    assert.equal(
      fs.existsSync(collidingTmpPath),
      true,
      `placed file at colliding temporary path was removed: ${collidingTmpName}`,
    );
    const afterBytes = fs.readFileSync(collidingTmpPath);
    expect(Buffer.compare(afterBytes, sentinelBytes)).toBe(0);
    expect(afterBytes).toEqual(sentinelBytes);
    expect(fs.statSync(collidingTmpPath).ino).toBe(beforeIno);

    // Follow-up acquire with normal random bytes succeeds and leaves the colliding file intact.
    const lease = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease.holderPid, lease.holderStartTime, "eexist-recovery-holder");
    try {
      expect(lease.epoch).toBe(1);
      expect(readOwnerRecord(stateRoot)?.epoch).toBe(1);
    } finally {
      await lease.release();
    }
    expect(suiteTracker.retireExternalIfDead(lease.holderPid, lease.holderStartTime)).toBe(true);
    expect(Buffer.compare(fs.readFileSync(collidingTmpPath), sentinelBytes)).toBe(0);
    expect(fs.statSync(collidingTmpPath).ino).toBe(beforeIno);
  });

  test("failed exclusive creation (EEXIST) on epoch bump preserves both the placed file and existing owner.json", async () => {
    const stateRoot = path.join(scratchRoot, "eexist-epoch-bump");
    const projectKey = "4400000000000002";

    const lease1 = await acquireLease({ projectKey, stateRoot });
    suiteTracker.trackExternal(lease1.holderPid, lease1.holderStartTime, "epoch1-holder");
    try {
      expect(lease1.epoch).toBe(1);
    } finally {
      await lease1.release();
    }
    expect(suiteTracker.retireExternalIfDead(lease1.holderPid, lease1.holderStartTime)).toBe(true);

    const ownerJsonPath = path.join(stateRoot, "owner.json");
    const ownerBefore = snapshotFile(ownerJsonPath);

    const fixedBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    const collidingTmpName = `.owner.json.tmp.${process.pid}.deadbeef0102`;
    const collidingTmpPath = path.join(stateRoot, collidingTmpName);
    const sentinelBytes = Buffer.from("epoch-bump-foreign-bytes-0123456789\n", "utf8");
    fs.writeFileSync(collidingTmpPath, sentinelBytes, { mode: 0o600 });
    const beforeIno = fs.statSync(collidingTmpPath).ino;

    const randomSpy = spyNextSixRandomBytes(fixedBytes);
    let obs: FailedAcquireObservation;
    try {
      obs = await runAcquireCapturingHolder(projectKey, stateRoot, "epoch2-eexist-holder");
    } finally {
      randomSpy.restore();
    }

    expect(randomSpy.getCallCount()).toBe(1);
    expect(obs.threw).toBe(true);
    expect(obs.caught).toBeInstanceOf(Error);
    expect(getErrorCode(obs.caught)).toBe("EEXIST");

    assert.ok(obs.holderPid !== null && obs.holderStartTime !== null);
    expect(suiteTracker.retireExternalIfDead(obs.holderPid, obs.holderStartTime)).toBe(true);
    expect(isLockFreeNonBlocking(path.join(stateRoot, "owner.lock"))).toBe(true);
    expect(getGlobalLeaseRegistry().has(projectKey)).toBe(false);

    assert.equal(
      fs.existsSync(collidingTmpPath),
      true,
      `placed file at colliding temporary path was removed: ${collidingTmpName}`,
    );
    const afterBytes = fs.readFileSync(collidingTmpPath);
    expect(Buffer.compare(afterBytes, sentinelBytes)).toBe(0);
    expect(afterBytes).toEqual(sentinelBytes);
    expect(fs.statSync(collidingTmpPath).ino).toBe(beforeIno);

    const ownerAfter = snapshotFile(ownerJsonPath);
    expect(ownerAfter.text).toBe(ownerBefore.text);
    expect(ownerAfter.sha256).toBe(ownerBefore.sha256);
    expect(ownerAfter.ino).toBe(ownerBefore.ino);
    expect(readOwnerRecord(stateRoot)?.epoch).toBe(1);
  });

  test("failure during writeFileSync or fsyncSync after exclusive creation closes fd, removes this call's temp file, and leaves unrelated files intact", async () => {
    // Subcase A: writeFileSync fails while the newly opened fd is still open.
    {
      const stateRoot = path.join(scratchRoot, "later-fail-write");
      const projectKey = "4400000000000003";
      fs.mkdirSync(stateRoot, { recursive: true });
      const realStateRoot = fs.realpathSync(stateRoot);

      const unrelatedTmpName = `.owner.json.tmp.${process.pid}.aaaaaaaaaaaa`;
      const unrelatedTmpPath = path.join(stateRoot, unrelatedTmpName);
      const unrelatedBytes = Buffer.from("unrelated-temp-write-case\n", "utf8");
      fs.writeFileSync(unrelatedTmpPath, unrelatedBytes, { mode: 0o600 });
      const unrelatedIno = fs.statSync(unrelatedTmpPath).ino;

      const fixedBytes = Buffer.from([0x21, 0x43, 0x65, 0x87, 0xa9, 0xcb]);
      const expectedTmpName = `.owner.json.tmp.${process.pid}.21436587a9cb`;
      const expectedTmpPath = path.join(stateRoot, expectedTmpName);
      const realExpectedTmpPath = path.join(realStateRoot, expectedTmpName);

      let sawCreatedTmpAtWrite = false;
      let sawOpenFdAtWrite = false;
      const origWriteFileSync = fs.writeFileSync.bind(fs);
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((...args: unknown[]) => {
        const target = args[0];
        if (
          typeof target === "number" &&
          fs.existsSync(expectedTmpPath) &&
          fs.fstatSync(target).ino === fs.statSync(expectedTmpPath).ino
        ) {
          sawCreatedTmpAtWrite = true;
          sawOpenFdAtWrite = hasOpenFdForPath(realExpectedTmpPath);
          throw Object.assign(new Error("forced ENOSPC on owner.json temp write"), {
            code: "ENOSPC",
          });
        }
        return (origWriteFileSync as (...a: unknown[]) => unknown)(...args);
      }) as typeof fs.writeFileSync);

      const randomSpy = spyNextSixRandomBytes(fixedBytes);
      let obs: FailedAcquireObservation;
      try {
        obs = await runAcquireCapturingHolder(projectKey, stateRoot, "write-fail-holder");
      } finally {
        randomSpy.restore();
        writeSpy.mockRestore();
      }

      expect(randomSpy.getCallCount()).toBe(1);
      expect(sawCreatedTmpAtWrite).toBe(true);
      expect(sawOpenFdAtWrite).toBe(true);
      expect(obs.threw).toBe(true);
      expect(obs.caught).toBeInstanceOf(Error);
      expect(getErrorCode(obs.caught)).toBe("ENOSPC");

      assert.ok(obs.holderPid !== null && obs.holderStartTime !== null);
      expect(suiteTracker.retireExternalIfDead(obs.holderPid, obs.holderStartTime)).toBe(true);
      expect(isLockFreeNonBlocking(path.join(stateRoot, "owner.lock"))).toBe(true);
      expect(getGlobalLeaseRegistry().has(projectKey)).toBe(false);
      expect(readOwnerRecord(stateRoot)).toBeNull();

      expect(fs.existsSync(expectedTmpPath)).toBe(false);
      expect(hasOpenFdForPath(realExpectedTmpPath)).toBe(false);
      expect(
        fs.readdirSync(stateRoot).filter((name) => name.startsWith(".owner.json.tmp.")),
      ).toEqual([unrelatedTmpName]);
      expect(Buffer.compare(fs.readFileSync(unrelatedTmpPath), unrelatedBytes)).toBe(0);
      expect(fs.statSync(unrelatedTmpPath).ino).toBe(unrelatedIno);
    }

    // Subcase B: fsyncSync fails after payload bytes are written while fd is still open.
    {
      const stateRoot = path.join(scratchRoot, "later-fail-fsync");
      const projectKey = "4400000000000004";
      fs.mkdirSync(stateRoot, { recursive: true });
      const realStateRoot = fs.realpathSync(stateRoot);

      const fixedBytes = Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x58]);
      const expectedTmpName = `.owner.json.tmp.${process.pid}.314159265358`;
      const expectedTmpPath = path.join(stateRoot, expectedTmpName);
      const realExpectedTmpPath = path.join(realStateRoot, expectedTmpName);

      let sawWrittenTmpAtFsync = false;
      let sawOpenFdAtFsync = false;
      const origFsyncSync = fs.fsyncSync.bind(fs);
      const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
        if (
          fs.existsSync(expectedTmpPath) &&
          fs.fstatSync(fd).ino === fs.statSync(expectedTmpPath).ino
        ) {
          sawWrittenTmpAtFsync = fs.statSync(expectedTmpPath).size > 0;
          sawOpenFdAtFsync = hasOpenFdForPath(realExpectedTmpPath);
          throw Object.assign(new Error("forced EIO on owner.json temp fsync"), {
            code: "EIO",
          });
        }
        return origFsyncSync(fd);
      });

      const randomSpy = spyNextSixRandomBytes(fixedBytes);
      let obs: FailedAcquireObservation;
      try {
        obs = await runAcquireCapturingHolder(projectKey, stateRoot, "fsync-fail-holder");
      } finally {
        randomSpy.restore();
        fsyncSpy.mockRestore();
      }

      expect(randomSpy.getCallCount()).toBe(1);
      expect(sawWrittenTmpAtFsync).toBe(true);
      expect(sawOpenFdAtFsync).toBe(true);
      expect(obs.threw).toBe(true);
      expect(obs.caught).toBeInstanceOf(Error);
      expect(getErrorCode(obs.caught)).toBe("EIO");

      assert.ok(obs.holderPid !== null && obs.holderStartTime !== null);
      expect(suiteTracker.retireExternalIfDead(obs.holderPid, obs.holderStartTime)).toBe(true);
      expect(isLockFreeNonBlocking(path.join(stateRoot, "owner.lock"))).toBe(true);
      expect(getGlobalLeaseRegistry().has(projectKey)).toBe(false);
      expect(readOwnerRecord(stateRoot)).toBeNull();

      expect(fs.existsSync(expectedTmpPath)).toBe(false);
      expect(hasOpenFdForPath(realExpectedTmpPath)).toBe(false);
      expect(
        fs.readdirSync(stateRoot).filter((name) => name.startsWith(".owner.json.tmp.")),
      ).toEqual([]);
    }
  });

  test("failure during renameSync after closing the temporary file removes this call's temp file and leaves unrelated files intact", async () => {
    const stateRoot = path.join(scratchRoot, "later-fail-rename");
    const projectKey = "4400000000000005";
    fs.mkdirSync(stateRoot, { recursive: true });
    const realStateRoot = fs.realpathSync(stateRoot);

    const unrelatedTmpName = `.owner.json.tmp.${process.pid}.bbbbbbbbbbbb`;
    const unrelatedTmpPath = path.join(stateRoot, unrelatedTmpName);
    const unrelatedBytes = Buffer.from("unrelated-temp-rename-case\n", "utf8");
    fs.writeFileSync(unrelatedTmpPath, unrelatedBytes, { mode: 0o600 });
    const unrelatedIno = fs.statSync(unrelatedTmpPath).ino;

    const fixedBytes = Buffer.from([0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc]);
    const expectedTmpName = `.owner.json.tmp.${process.pid}.778899aabbcc`;
    const expectedTmpPath = path.join(stateRoot, expectedTmpName);
    const realExpectedTmpPath = path.join(realStateRoot, expectedTmpName);
    const ownerJsonPath = path.join(stateRoot, "owner.json");

    let sawCreatedTmpAtRename = false;
    let sawFdClosedBeforeRename = false;
    let writtenEpoch: number | null = null;
    const origRenameSync = fs.renameSync.bind(fs);
    const renameSpy = spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      if (String(oldPath) === expectedTmpPath && String(newPath) === ownerJsonPath) {
        sawCreatedTmpAtRename = fs.existsSync(expectedTmpPath);
        sawFdClosedBeforeRename = !hasOpenFdForPath(realExpectedTmpPath);
        const parsed = JSON.parse(fs.readFileSync(expectedTmpPath, "utf8")) as {
          epoch?: unknown;
          projectKey?: unknown;
        };
        if (parsed.projectKey === projectKey && typeof parsed.epoch === "number") {
          writtenEpoch = parsed.epoch;
        }
        throw Object.assign(new Error("forced EIO on owner.json rename"), { code: "EIO" });
      }
      return origRenameSync(oldPath, newPath);
    });

    const randomSpy = spyNextSixRandomBytes(fixedBytes);
    let obs: FailedAcquireObservation;
    try {
      obs = await runAcquireCapturingHolder(projectKey, stateRoot, "rename-fail-holder");
    } finally {
      randomSpy.restore();
      renameSpy.mockRestore();
    }

    expect(randomSpy.getCallCount()).toBe(1);
    expect(sawCreatedTmpAtRename).toBe(true);
    expect(sawFdClosedBeforeRename).toBe(true);
    expect(writtenEpoch).toBe(1);
    expect(obs.threw).toBe(true);
    expect(obs.caught).toBeInstanceOf(Error);
    expect(getErrorCode(obs.caught)).toBe("EIO");

    assert.ok(obs.holderPid !== null && obs.holderStartTime !== null);
    expect(suiteTracker.retireExternalIfDead(obs.holderPid, obs.holderStartTime)).toBe(true);
    expect(isLockFreeNonBlocking(path.join(stateRoot, "owner.lock"))).toBe(true);
    expect(getGlobalLeaseRegistry().has(projectKey)).toBe(false);
    expect(readOwnerRecord(stateRoot)).toBeNull();

    expect(fs.existsSync(expectedTmpPath)).toBe(false);
    expect(
      fs.readdirSync(stateRoot).filter((name) => name.startsWith(".owner.json.tmp.")),
    ).toEqual([unrelatedTmpName]);
    expect(Buffer.compare(fs.readFileSync(unrelatedTmpPath), unrelatedBytes)).toBe(0);
    expect(fs.statSync(unrelatedTmpPath).ino).toBe(unrelatedIno);
  });
});
