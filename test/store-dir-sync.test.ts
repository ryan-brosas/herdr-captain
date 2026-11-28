import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "bun:test";
import type { OwnerLease } from "../src/lease.ts";
import {
  appendCommitRecord,
  getTicketPaths,
  openTicketLog,
  readArtifact,
  writeArtifact,
  type StoreFsOps,
} from "../src/store.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import {
  createStoreTestContext,
  DEFAULT_PROJECT_KEY,
  expectErrorCode,
  makeIntentInput,
  makeReceiptInput,
  runWrite,
  sha256Hex,
} from "./helpers/store-fixtures.ts";

assertSupportedBunVersion(Bun.version);

function makeErrno(code: string, syscall: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: injected failure in ${syscall}`) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = syscall;
  return err;
}

interface DirSyncSpyOptions {
  readonly forceShortWrite?: boolean;
  readonly onLstatSync?: (targetPath: string, real: typeof fs.lstatSync) => fs.Stats;
  readonly onMkdirSync?: (
    targetPath: string,
    options: fs.MakeDirectoryOptions | fs.Mode | null | undefined,
    real: typeof fs.mkdirSync,
  ) => string | undefined;
  readonly onOpenSync?: (targetPath: string, flags: fs.PathOrFileDescriptor | fs.OpenMode) => void;
  readonly onFsyncDir?: (resolvedDirPath: string) => void;
  readonly onReaddirSync?: (targetPath: string) => void;
}

interface DirSyncSpy {
  readonly lease: OwnerLease;
  readonly fsOps: Partial<StoreFsOps>;
  readonly trace: string[];
  readonly events: string[];
  readonly mkdirPaths: string[];
  readonly mkdirEexistPaths: string[];
  readonly syncedDirs: string[];
  readonly syncedDirsBeforeOpenTemp: string[];
}

function createDirSyncSpy(lease: OwnerLease, opts?: DirSyncSpyOptions): DirSyncSpy {
  const trace: string[] = [];
  const events: string[] = [];
  const mkdirPaths: string[] = [];
  const mkdirEexistPaths: string[] = [];
  const syncedDirs: string[] = [];
  const syncedDirsBeforeOpenTemp: string[] = [];

  const dirFds = new Map<number, string>();
  const tempFds = new Set<number>();
  let openTempSeen = false;
  let forcedShortWrite = false;

  const observedLease: OwnerLease = {
    ...lease,
    assertValid() {
      trace.push("assertValid");
      lease.assertValid();
    },
  };

  const fsOps: Partial<StoreFsOps> = {
    lstatSync: ((targetPath: fs.PathLike, options?: fs.StatSyncOptions) => {
      const targetStr = String(targetPath);
      if (opts?.onLstatSync !== undefined) {
        return opts.onLstatSync(targetStr, fs.lstatSync);
      }
      return fs.lstatSync(targetPath, options as never);
    }) as typeof fs.lstatSync,

    readdirSync: ((targetPath: fs.PathLike, options?: unknown) => {
      trace.push("readdir");
      opts?.onReaddirSync?.(String(targetPath));
      return fs.readdirSync(targetPath, options as never);
    }) as typeof fs.readdirSync,

    mkdirSync: ((targetPath: fs.PathLike, options?: fs.MakeDirectoryOptions | fs.Mode | null) => {
      const resolved = path.resolve(String(targetPath));
      try {
        const res =
          opts?.onMkdirSync !== undefined
            ? opts.onMkdirSync(String(targetPath), options, fs.mkdirSync)
            : fs.mkdirSync(targetPath, options as never);
        mkdirPaths.push(resolved);
        trace.push("mkdir");
        events.push(`mkdir:${resolved}`);
        return res;
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EEXIST") {
          mkdirEexistPaths.push(resolved);
          trace.push("mkdir_eexist");
          events.push(`mkdir_eexist:${resolved}`);
        }
        throw err;
      }
    }) as typeof fs.mkdirSync,

    openSync(targetPath, flags, mode) {
      const isCreate = typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0;
      const isDir = typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0;
      opts?.onOpenSync?.(String(targetPath), flags);
      if (!isCreate && !isDir) {
        trace.push("openRead");
      }
      const fd = fs.openSync(targetPath, flags, mode);
      if (isCreate) {
        tempFds.add(fd);
        openTempSeen = true;
        trace.push("openTemp");
        events.push("openTemp");
      } else if (isDir) {
        const resolved = path.resolve(String(targetPath));
        dirFds.set(fd, resolved);
        trace.push("openDir");
      }
      return fd;
    },

    writeSync: ((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset?: number | null,
      length?: number | null,
      position?: fs.ReadPosition | null,
    ): number => {
      const off = offset ?? 0;
      let len = length ?? buffer.byteLength - off;
      if (tempFds.has(fd)) {
        trace.push("writeTemp");
        if (opts?.forceShortWrite === true && !forcedShortWrite && len > 1) {
          forcedShortWrite = true;
          len = Math.max(1, Math.floor(len / 2));
        }
      }
      return fs.writeSync(fd, buffer, off, len, position ?? null);
    }) as typeof fs.writeSync,

    fsyncSync(fd) {
      if (tempFds.has(fd)) {
        trace.push("fsyncTemp");
        fs.fsyncSync(fd);
        return;
      }
      const dirPath = dirFds.get(fd);
      assert.ok(dirPath !== undefined, `Unexpected fsyncSync on untracked fd=${fd}`);
      opts?.onFsyncDir?.(dirPath);
      fs.fsyncSync(fd);
      syncedDirs.push(dirPath);
      if (!openTempSeen) {
        syncedDirsBeforeOpenTemp.push(dirPath);
      }
      trace.push("fsyncDir");
      events.push(`fsyncDir:${dirPath}`);
    },

    closeSync(fd) {
      if (tempFds.delete(fd)) {
        trace.push("closeTemp");
      } else if (dirFds.delete(fd)) {
        trace.push("closeDir");
      }
      fs.closeSync(fd);
    },

    linkSync(existingPath, newPath) {
      trace.push("link");
      events.push("link");
      fs.linkSync(existingPath, newPath);
    },

    removeTemp(targetPath) {
      trace.push("removeTemp");
      fs.unlinkSync(targetPath);
    },
  };

  return {
    lease: observedLease,
    fsOps,
    trace,
    events,
    mkdirPaths,
    mkdirEexistPaths,
    syncedDirs,
    syncedDirsBeforeOpenTemp,
  };
}

async function runRetryAfterFailedSyncCase(mode: "appendCommitRecord" | "writeArtifact"): Promise<void> {
  const ctx = createStoreTestContext(`herdr-s1c-h1-retry-${mode}-`);
  try {
    const stateRoot = path.join(ctx.scratchRoot, "state");
    const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, `h1-retry-${mode}`);
    const issueRef = mode === "appendCommitRecord" ? "example/repo#471" : "example/repo#472";
    const paths = getTicketPaths(stateRoot, issueRef);
    const resolvedStateRoot = path.resolve(stateRoot);
    const resolvedTicketsDir = path.resolve(path.dirname(paths.ticketDir));
    const resolvedTicketDir = path.resolve(paths.ticketDir);
    const resolvedLeafDir = path.resolve(mode === "appendCommitRecord" ? paths.logDir : paths.artifactsDir);
    const artifactBody = Buffer.from("h1-retry-artifact-content\n", "utf8");
    const artifactSha = sha256Hex(artifactBody);

    // Call 1: creates tickets/, then syncing stateRoot fails with injected EIO.
    const firstSpy = createDirSyncSpy(lease, {
      onFsyncDir(dirPath) {
        if (dirPath === resolvedStateRoot) {
          throw makeErrno("EIO", "fsync");
        }
      },
    });

    await expectErrorCode(
      () =>
        runWrite(lease, () =>
          mode === "appendCommitRecord"
            ? appendCommitRecord(firstSpy.lease, makeIntentInput({ issueRef }), { fs: firstSpy.fsOps })
            : writeArtifact(firstSpy.lease, issueRef, artifactBody, { fs: firstSpy.fsOps }),
        ),
      "EIO",
      `${mode}: first call must fail with EIO on stateRoot sync`,
    );

    assert.deepEqual(
      firstSpy.mkdirPaths,
      [resolvedTicketsDir],
      `${mode}: first call must have created only tickets/ before failing stateRoot sync`,
    );
    assert.equal(fs.existsSync(resolvedTicketsDir), true, `${mode}: tickets/ should remain on disk`);
    assert.equal(fs.existsSync(resolvedTicketDir), false, `${mode}: ticket dir must not exist yet`);
    assert.deepEqual(firstSpy.syncedDirs, [], `${mode}: stateRoot sync failed before completing`);

    // Call 2: no injected error; must sync stateRoot, tickets/, and ticketDir before creating temp file.
    const retrySpy = createDirSyncSpy(lease);
    if (mode === "appendCommitRecord") {
      const entry = await runWrite(lease, () =>
        appendCommitRecord(retrySpy.lease, makeIntentInput({ issueRef }), { fs: retrySpy.fsOps }),
      );
      assert.equal(entry.seq, 1);
      const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
      assert.equal(opened.status, "clean");
      assert.equal(opened.records.length, 1);
      assert.equal(opened.records[0]!.sha256, entry.sha256);
    } else {
      const res = await runWrite(lease, () =>
        writeArtifact(retrySpy.lease, issueRef, artifactBody, { fs: retrySpy.fsOps }),
      );
      assert.equal(res.created, true);
      assert.equal(res.sha256, artifactSha);
      const read = readArtifact({ stateRoot, issueRef, sha256: artifactSha });
      assert.equal(Buffer.compare(read.content, artifactBody), 0);
    }

    assert.deepEqual(
      retrySpy.mkdirPaths,
      [resolvedTicketDir, resolvedLeafDir],
      `${mode}: retry must create only the missing ticket and leaf directories`,
    );
    assert.deepEqual(
      retrySpy.syncedDirsBeforeOpenTemp,
      [resolvedStateRoot, resolvedTicketsDir, resolvedTicketDir],
      `${mode}: retry must sync stateRoot, tickets/, and ticket dir before openTemp`,
    );
    assert.deepEqual(
      retrySpy.syncedDirs,
      [resolvedStateRoot, resolvedTicketsDir, resolvedTicketDir, resolvedLeafDir],
      `${mode}: retry must sync all three parents and post-link leaf dir`,
    );
    assert.deepEqual(
      retrySpy.events,
      [
        `fsyncDir:${resolvedStateRoot}`,
        `mkdir:${resolvedTicketDir}`,
        `fsyncDir:${resolvedTicketsDir}`,
        `mkdir:${resolvedLeafDir}`,
        `fsyncDir:${resolvedTicketDir}`,
        "openTemp",
        "link",
        `fsyncDir:${resolvedLeafDir}`,
      ],
      `${mode}: retry must sync each parent before moving to the next segment and temp creation`,
    );

    await lease.release();
  } finally {
    await ctx.cleanup();
  }
}

describe("commit-log store parent directory sync on existing folders (fix round 2: H1)", () => {
  test("proof 4: appendCommitRecord retry after failed stateRoot sync syncs stateRoot, tickets/, and ticket dir before creating temp file", async () => {
    await runRetryAfterFailedSyncCase("appendCommitRecord");
  });

  test("proof 4: writeArtifact retry after failed stateRoot sync syncs stateRoot, tickets/, and ticket dir before creating temp file", async () => {
    await runRetryAfterFailedSyncCase("writeArtifact");
  });

  test("proof 3: pre-existing folder chain created with plain mkdir syncs all three parents on first and subsequent publications for appendCommitRecord and writeArtifact", async () => {
    const ctx = createStoreTestContext("herdr-s1c-h1-preexisting-");
    try {
      for (const mode of ["appendCommitRecord", "writeArtifact"] as const) {
        const stateRoot = path.join(ctx.scratchRoot, `state-${mode}`);
        const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, `h1-pre-${mode}`);
        const issueRef = mode === "appendCommitRecord" ? "example/repo#371" : "example/repo#372";
        const paths = getTicketPaths(stateRoot, issueRef);
        const resolvedStateRoot = path.resolve(stateRoot);
        const resolvedTicketsDir = path.resolve(path.dirname(paths.ticketDir));
        const resolvedTicketDir = path.resolve(paths.ticketDir);
        const resolvedLeafDir = path.resolve(mode === "appendCommitRecord" ? paths.logDir : paths.artifactsDir);

        // Pre-create all three folders with plain mkdir (never synced by the store).
        fs.mkdirSync(resolvedLeafDir, { recursive: true });

        // First publication must sync all three parents before creating its temporary file.
        const firstSpy = createDirSyncSpy(lease);
        if (mode === "appendCommitRecord") {
          const rec1 = await runWrite(lease, () =>
            appendCommitRecord(firstSpy.lease, makeIntentInput({ issueRef }), { fs: firstSpy.fsOps }),
          );
          assert.equal(rec1.seq, 1);
        } else {
          const body1 = Buffer.from("h1-preexisting-artifact-1\n", "utf8");
          const art1 = await runWrite(lease, () =>
            writeArtifact(firstSpy.lease, issueRef, body1, { fs: firstSpy.fsOps }),
          );
          assert.equal(art1.created, true);
          assert.equal(Buffer.compare(readArtifact({ stateRoot, issueRef, sha256: art1.sha256 }).content, body1), 0);
        }

        assert.deepEqual(firstSpy.mkdirPaths, [], `${mode}: first call must not call mkdir on existing chain`);
        assert.deepEqual(
          firstSpy.syncedDirsBeforeOpenTemp,
          [resolvedStateRoot, resolvedTicketsDir, resolvedTicketDir],
          `${mode}: first publication must sync all three parents before openTemp`,
        );
        assert.deepEqual(
          firstSpy.syncedDirs,
          [resolvedStateRoot, resolvedTicketsDir, resolvedTicketDir, resolvedLeafDir],
          `${mode}: first publication must sync all three parents plus leaf dir`,
        );

        // A sync error on an already-existing parent folder surfaces its errno code and writes nothing.
        const errSpy = createDirSyncSpy(lease, {
          onFsyncDir(dirPath) {
            if (dirPath === resolvedTicketsDir) {
              throw makeErrno("EIO", "fsync");
            }
          },
        });
        const failBody = Buffer.from("h1-preexisting-eio-artifact\n", "utf8");
        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              mode === "appendCommitRecord"
                ? appendCommitRecord(errSpy.lease, makeReceiptInput({ issueRef }), { fs: errSpy.fsOps })
                : writeArtifact(errSpy.lease, issueRef, failBody, { fs: errSpy.fsOps }),
            ),
          "EIO",
          `${mode}: parent sync error on existing folder must surface EIO`,
        );
        assert.deepEqual(
          errSpy.syncedDirs,
          [resolvedStateRoot],
          `${mode}: failed sync on tickets/ must stop before syncing ticketDir or creating temp`,
        );
        assert.equal(errSpy.events.includes("openTemp"), false, `${mode}: failed parent sync must not create temp file`);

        // Second publication must sync all three parents again (no in-memory sync cache).
        const secondSpy = createDirSyncSpy(lease);
        if (mode === "appendCommitRecord") {
          const rec2 = await runWrite(lease, () =>
            appendCommitRecord(secondSpy.lease, makeReceiptInput({ issueRef }), { fs: secondSpy.fsOps }),
          );
          assert.equal(rec2.seq, 2);
          const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
          assert.equal(opened.status, "clean");
          assert.equal(opened.records.length, 2);
        } else {
          const body2 = Buffer.from("h1-preexisting-artifact-2\n", "utf8");
          const art2 = await runWrite(lease, () =>
            writeArtifact(secondSpy.lease, issueRef, body2, { fs: secondSpy.fsOps }),
          );
          assert.equal(art2.created, true);
          assert.equal(Buffer.compare(readArtifact({ stateRoot, issueRef, sha256: art2.sha256 }).content, body2), 0);
        }

        assert.deepEqual(secondSpy.mkdirPaths, [], `${mode}: second call must not call mkdir on existing chain`);
        assert.deepEqual(
          secondSpy.syncedDirsBeforeOpenTemp,
          [resolvedStateRoot, resolvedTicketsDir, resolvedTicketDir],
          `${mode}: second publication must sync all three parents again (no in-memory cache)`,
        );
        assert.deepEqual(
          secondSpy.syncedDirs,
          [resolvedStateRoot, resolvedTicketsDir, resolvedTicketDir, resolvedLeafDir],
          `${mode}: second publication must sync all three parents plus leaf dir`,
        );

        await lease.release();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 3: ensureDirChain syncs parent directory when first lstat reports ENOENT and mkdirSync hits EEXIST on a real directory, while refusing symlinks and non-directories", async () => {
    const ctx = createStoreTestContext("herdr-s1c-h1-eexist-");
    try {
      // Part A: EEXIST against real directories still syncs each parent before advancing.
      for (const mode of ["appendCommitRecord", "writeArtifact"] as const) {
        const stateRoot = path.join(ctx.scratchRoot, `state-${mode}`);
        const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, `h1-eexist-${mode}`);
        const issueRef = mode === "appendCommitRecord" ? "example/repo#381" : "example/repo#382";
        const paths = getTicketPaths(stateRoot, issueRef);
        const resolvedStateRoot = path.resolve(stateRoot);
        const resolvedTicketsDir = path.resolve(path.dirname(paths.ticketDir));
        const resolvedTicketDir = path.resolve(paths.ticketDir);
        const resolvedLeafDir = path.resolve(mode === "appendCommitRecord" ? paths.logDir : paths.artifactsDir);
        const chainTargets = new Set([resolvedTicketsDir, resolvedTicketDir, resolvedLeafDir]);
        const artifactBody = Buffer.from("h1-eexist-artifact-body\n", "utf8");
        const artifactSha = sha256Hex(artifactBody);
        const resolvedArtifactPath = path.resolve(path.join(paths.artifactsDir, `${artifactSha}.md`));

        fs.mkdirSync(resolvedLeafDir, { recursive: true });

        let preReadFinished = false;
        const fakedEnoent = new Set<string>();
        const spy = createDirSyncSpy(lease, {
          onReaddirSync() {
            if (mode === "appendCommitRecord") {
              preReadFinished = true;
            }
          },
          onOpenSync(targetPath) {
            if (mode === "writeArtifact" && path.resolve(targetPath) === resolvedArtifactPath) {
              preReadFinished = true;
            }
          },
          onLstatSync(targetPath, real) {
            const resolved = path.resolve(targetPath);
            if (preReadFinished && chainTargets.has(resolved) && !fakedEnoent.has(resolved)) {
              fakedEnoent.add(resolved);
              throw makeErrno("ENOENT", "lstat");
            }
            return real(targetPath);
          },
        });

        if (mode === "appendCommitRecord") {
          const entry = await runWrite(lease, () =>
            appendCommitRecord(spy.lease, makeIntentInput({ issueRef }), { fs: spy.fsOps }),
          );
          assert.equal(entry.seq, 1);
          const opened = openTicketLog({ stateRoot, projectKey: DEFAULT_PROJECT_KEY, issueRef });
          assert.equal(opened.status, "clean");
          assert.equal(opened.records.length, 1);
        } else {
          const res = await runWrite(lease, () =>
            writeArtifact(spy.lease, issueRef, artifactBody, { fs: spy.fsOps }),
          );
          assert.equal(res.created, true);
          assert.equal(Buffer.compare(readArtifact({ stateRoot, issueRef, sha256: artifactSha }).content, artifactBody), 0);
        }

        assert.deepEqual(
          [...fakedEnoent],
          [resolvedTicketsDir, resolvedTicketDir, resolvedLeafDir],
          `${mode}: first lstat in ensureDirChain must report ENOENT for all three segments`,
        );
        assert.deepEqual(
          spy.mkdirEexistPaths,
          [resolvedTicketsDir, resolvedTicketDir, resolvedLeafDir],
          `${mode}: mkdirSync must hit real OS EEXIST for all three segments`,
        );
        assert.deepEqual(
          spy.syncedDirsBeforeOpenTemp,
          [resolvedStateRoot, resolvedTicketsDir, resolvedTicketDir],
          `${mode}: EEXIST on real directories must still sync all three parents before openTemp`,
        );
        assert.deepEqual(
          spy.events,
          [
            `mkdir_eexist:${resolvedTicketsDir}`,
            `fsyncDir:${resolvedStateRoot}`,
            `mkdir_eexist:${resolvedTicketDir}`,
            `fsyncDir:${resolvedTicketsDir}`,
            `mkdir_eexist:${resolvedLeafDir}`,
            `fsyncDir:${resolvedTicketDir}`,
            "openTemp",
            "link",
            `fsyncDir:${resolvedLeafDir}`,
          ],
          `${mode}: each parent sync must run right after EEXIST verification and before next segment`,
        );

        await lease.release();
      }

      // Part B: symlinks and non-directories at ensureDirChain (first look and EEXIST) are refused without syncing parent.
      for (const badKind of ["first-look-symlink", "eexist-file", "eexist-symlink"] as const) {
        const stateRoot = path.join(ctx.scratchRoot, `state-bad-${badKind}`);
        const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, `h1-bad-${badKind}`);
        const issueRef = "example/repo#389";
        const paths = getTicketPaths(stateRoot, issueRef);
        const resolvedTicketDir = path.resolve(paths.ticketDir);
        const resolvedLogDir = path.resolve(paths.logDir);
        const decoyDir = path.join(ctx.scratchRoot, `decoy-${badKind}`);
        fs.mkdirSync(decoyDir, { recursive: true });
        fs.mkdirSync(resolvedTicketDir, { recursive: true });

        // openTicketLog sees ticketDir exists and logDir absent -> clean empty.
        // Then inside ensureDirChain, logDir becomes a symlink or regular file.
        let sawOpenTicketLogLstat = false;
        let injectedBadEntry = false;
        const badSpy = createDirSyncSpy(lease, {
          onLstatSync(targetPath, real) {
            const resolved = path.resolve(targetPath);
            if (resolved === resolvedLogDir) {
              if (!sawOpenTicketLogLstat) {
                sawOpenTicketLogLstat = true;
                return real(targetPath);
              }
              if (badKind === "first-look-symlink" && !injectedBadEntry) {
                injectedBadEntry = true;
                fs.symlinkSync(decoyDir, resolvedLogDir);
              }
            }
            return real(targetPath);
          },
          onMkdirSync(targetPath, options, real) {
            const resolved = path.resolve(targetPath);
            if (resolved === resolvedLogDir && !injectedBadEntry) {
              injectedBadEntry = true;
              if (badKind === "eexist-file") {
                fs.writeFileSync(resolvedLogDir, "not-a-dir\n");
              } else if (badKind === "eexist-symlink") {
                fs.symlinkSync(decoyDir, resolvedLogDir);
              }
            }
            return real(targetPath, options as never);
          },
        });

        await expectErrorCode(
          () =>
            runWrite(lease, () =>
              appendCommitRecord(badSpy.lease, makeIntentInput({ issueRef }), { fs: badSpy.fsOps }),
            ),
          badKind === "first-look-symlink" ? "ENOTDIR" : "EEXIST",
          `${badKind}: non-directory or symlink at log/ must be refused`,
        );

        assert.equal(
          badSpy.syncedDirs.includes(resolvedTicketDir),
          false,
          `${badKind}: parent ticketDir must not be synced when log/ is refused`,
        );
        assert.equal(fs.existsSync(path.join(decoyDir, "000001.json")), false, `${badKind}: nothing written behind symlink`);

        await lease.release();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  test("proof 5: ruling 8 lease-check placement places no assertValid before added parent dir syncs on existing folders or EEXIST", async () => {
    const ctx = createStoreTestContext("herdr-s1c-h1-ruling8-");
    try {
      const stateRoot = path.join(ctx.scratchRoot, "state");
      const lease = await ctx.acquireTrackedLease(stateRoot, DEFAULT_PROJECT_KEY, "h1-r8-holder");
      const issueRef = "example/repo#518";
      const paths = getTicketPaths(stateRoot, issueRef);
      const resolvedTicketsDir = path.resolve(path.dirname(paths.ticketDir));
      const resolvedTicketDir = path.resolve(paths.ticketDir);
      const resolvedLogDir = path.resolve(paths.logDir);

      const assertRuling8Trace = (
        label: string,
        trace: readonly string[],
        expectedMkdirCount: number,
        mkdirToken: "mkdir" | "mkdir_eexist",
      ): void => {
        const fsyncDirCount = trace.filter((op) => op === "fsyncDir").length;
        const mkdirCount = trace.filter((op) => op === mkdirToken).length;
        const writeTempCount = trace.filter((op) => op === "writeTemp").length;
        const assertValidCount = trace.filter((op) => op === "assertValid").length;

        assert.equal(mkdirCount, expectedMkdirCount, `${label}: unexpected mkdir count; trace=${trace.join(" -> ")}`);
        assert.equal(
          fsyncDirCount,
          4,
          `${label}: expected 4 fsyncDir calls (3 parent dirs + post-link dir), got ${fsyncDirCount}; trace=${trace.join(" -> ")}`,
        );
        assert.ok(writeTempCount >= 2, `${label}: expected >= 2 writeTemp calls; trace=${trace.join(" -> ")}`);

        const mutatingOps = new Set([mkdirToken, "openTemp", "writeTemp", "link", "removeTemp"]);
        const nonMutatingSyncOps = new Set(["openDir", "fsyncDir", "closeDir", "fsyncTemp", "closeTemp"]);
        for (let i = 0; i < trace.length; i += 1) {
          const op = trace[i]!;
          if (mutatingOps.has(op)) {
            assert.equal(
              trace[i - 1],
              "assertValid",
              `${label}: expected assertValid immediately before ${op}; trace=${trace.join(" -> ")}`,
            );
          }
          if (nonMutatingSyncOps.has(op)) {
            assert.notEqual(
              trace[i - 1],
              "assertValid",
              `${label}: ${op} must not have an assertValid of its own; trace=${trace.join(" -> ")}`,
            );
          }
        }
        // Entry check (1) + mkdir checks + openTemp (1) + writeTempCount + link (1) + removeTemp (1).
        assert.equal(
          assertValidCount,
          1 + expectedMkdirCount + 1 + writeTempCount + 1 + 1,
          `${label}: unexpected total assertValid count; trace=${trace.join(" -> ")}`,
        );
      };

      // Seed record 1 and artifact 1 so both folder chains exist.
      const rec1 = await runWrite(lease, () => appendCommitRecord(lease, makeIntentInput({ issueRef })));
      assert.equal(rec1.seq, 1);
      const art1 = await runWrite(lease, () => writeArtifact(lease, issueRef, "ruling8-seed-artifact\n"));
      assert.equal(art1.created, true);

      // Case A: appendCommitRecord into existing folder chain (0 mkdir, 4 fsyncDir).
      {
        const spy = createDirSyncSpy(lease, { forceShortWrite: true });
        const rec2 = await runWrite(lease, () =>
          appendCommitRecord(spy.lease, makeReceiptInput({ issueRef }), { fs: spy.fsOps }),
        );
        assert.equal(rec2.seq, 2);
        assertRuling8Trace("appendCommitRecord existing chain", spy.trace, 0, "mkdir");
      }

      // Case B: appendCommitRecord with EEXIST on all three segments (3 mkdir_eexist, 4 fsyncDir).
      {
        const chainTargets = new Set([resolvedTicketsDir, resolvedTicketDir, resolvedLogDir]);
        let preReadFinished = false;
        const fakedEnoent = new Set<string>();
        const spy = createDirSyncSpy(lease, {
          forceShortWrite: true,
          onReaddirSync() {
            preReadFinished = true;
          },
          onLstatSync(targetPath, real) {
            const resolved = path.resolve(targetPath);
            if (preReadFinished && chainTargets.has(resolved) && !fakedEnoent.has(resolved)) {
              fakedEnoent.add(resolved);
              throw makeErrno("ENOENT", "lstat");
            }
            return real(targetPath);
          },
        });
        const rec3 = await runWrite(lease, () =>
          appendCommitRecord(spy.lease, makeIntentInput({ issueRef }), { fs: spy.fsOps }),
        );
        assert.equal(rec3.seq, 3);
        assertRuling8Trace("appendCommitRecord EEXIST chain", spy.trace, 3, "mkdir_eexist");
      }

      // Case C: writeArtifact into existing folder chain (0 mkdir, 4 fsyncDir).
      {
        const spy = createDirSyncSpy(lease, { forceShortWrite: true });
        const art2 = await runWrite(lease, () =>
          writeArtifact(spy.lease, issueRef, "ruling8-second-artifact-body\n", { fs: spy.fsOps }),
        );
        assert.equal(art2.created, true);
        assertRuling8Trace("writeArtifact existing chain", spy.trace, 0, "mkdir");
      }

      await lease.release();
    } finally {
      await ctx.cleanup();
    }
  });
});
