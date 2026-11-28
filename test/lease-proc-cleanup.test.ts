import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { readProcessStat } from "../src/lease.ts";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";
import {
  createFixtureProcRoot,
  makeStatLine,
  setupLeaseSuiteHooks,
  type FixtureProcEntry,
} from "./helpers/lease-fixtures.ts";
import {
  confirmProcessDead,
  findProcessesByEnvToken,
  scanProcessesByEnvToken,
  stopProcessesByEnvToken,
} from "./helpers/process.ts";

assertSupportedBunVersion(Bun.version);

let scratchRoot = "";
setupLeaseSuiteHooks((dir) => {
  scratchRoot = dir;
});

describe("Ported P2 negative controls (broken adapters and injected failures, zero source rewrites)", () => {
  test("cleanup helpers throw instead of reporting success when /proc is unreadable", async () => {
    const selfStat = readProcessStat(process.pid);
    assert.ok(selfStat !== null);

    // Regular file as procRoot triggers ENOTDIR for every user (including root).
    const fileProc = path.join(scratchRoot, "not-a-proc-dir");
    fs.writeFileSync(fileProc, "not a directory\n", "utf8");
    expect(() => confirmProcessDead(process.pid, selfStat.startTime, fileProc)).toThrow();
    expect(() => findProcessesByEnvToken("HERDR_TEST_TOKEN", "abc", fileProc)).toThrow();
    await expect(stopProcessesByEnvToken("HERDR_TEST_TOKEN", "abc", 200, fileProc)).rejects.toThrow();

    // Unreadable chmod 0o000 directory as procRoot triggers EACCES for non-root users.
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const noAccessProc = path.join(scratchRoot, "no-access-proc");
      fs.mkdirSync(noAccessProc, { recursive: true });
      fs.chmodSync(noAccessProc, 0o000);
      try {
        expect(() => confirmProcessDead(process.pid, selfStat.startTime, noAccessProc)).toThrow();
        expect(() => findProcessesByEnvToken("HERDR_TEST_TOKEN", "abc", noAccessProc)).toThrow();
        await expect(
          stopProcessesByEnvToken("HERDR_TEST_TOKEN", "abc", 200, noAccessProc),
        ).rejects.toThrow();
      } finally {
        fs.chmodSync(noAccessProc, 0o755);
      }
    }
  });

  test("fixture proc root: unreadable entry that may be ours is reported uncertain and fails cleanup", async () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) {
      return;
    }
    const myUid = process.getuid();
    const otherUid = 0;
    const sameNsUidMap = `${myUid} ${myUid} 1\n`;
    const fixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-unreadable-ours"),
      "50000",
      [
        {
          pid: 9000001,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000001, "worker", "S", "50000"),
          environ: "HERDR_TEST_TOKEN=tok-ours\0",
          environMode: 0o000,
        },
        {
          pid: 9000002,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000002, "worker", "S", "50010"),
          environ: "HERDR_TEST_TOKEN=tok-ours\0",
          environMode: 0o000,
        },
        {
          // Setuid-like process where real UID is ours and effective/saved/fs UIDs are root: still may be ours.
          pid: 9000003,
          uids: [myUid, otherUid, otherUid, otherUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000003, "helper", "S", "50020"),
          environ: "HERDR_TEST_TOKEN=tok-ours\0",
          environMode: 0o000,
        },
        {
          // Unreadable stat without status file (unknown owner stays maybe_ours).
          pid: 9000004,
          stat: makeStatLine(9000004, "worker", "S", "50030"),
          statMode: 0o000,
          environ: "PATH=/usr/bin\0",
        },
      ],
      sameNsUidMap,
    );

    try {
      const scan = scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-ours", fixture.procRoot);
      expect(scan.matches).toEqual([]);
      const uncertainSorted = [...scan.uncertain].sort((a, b) => a.pid - b.pid);
      expect(uncertainSorted).toEqual([
        { pid: 9000001, startTime: "50000", reason: "unreadable_environ" },
        { pid: 9000002, startTime: "50010", reason: "unreadable_environ" },
        { pid: 9000003, startTime: "50020", reason: "unreadable_environ" },
        { pid: 9000004, reason: "unreadable_stat" },
      ]);

      expect(() =>
        findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-ours", fixture.procRoot),
      ).toThrow(/Uncertain process cleanup.*pid=9000001/);
      await expect(
        stopProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-ours", 200, fixture.procRoot),
      ).rejects.toThrow(/Uncertain process cleanup.*unreadable_environ/);
      expect(() => confirmProcessDead(9000004, "50030", fixture.procRoot)).toThrow();
    } finally {
      fixture.restoreModes();
    }
  });

  test("fixture proc root: unreadable entry proven not ours (other user or older start time) is skipped cleanly", async () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) {
      return;
    }
    const myUid = process.getuid();
    const otherUid = myUid === 0 ? 65534 : 0;
    const sameNsUidMap = `${myUid} ${myUid} 1\n`;
    const fixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-unreadable-not-ours"),
      "50000",
      [
        {
          // Proof 1: owned by another user (all 4 UIDs != myUid), even though started after us.
          pid: 9000011,
          uids: [otherUid, otherUid, otherUid, otherUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000011, "daemon", "S", "50050"),
          environ: "SECRET=1\0",
          environMode: 0o000,
        },
        {
          // Proof 1 with unreadable stat: owned by another user.
          pid: 9000012,
          uids: [otherUid, otherUid, otherUid, otherUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000012, "daemon", "S", "50050"),
          statMode: 0o000,
          environ: "SECRET=1\0",
          environMode: 0o000,
        },
        {
          // Proof 2: same user, but started strictly before our run's token existed (e.g. a key agent).
          pid: 9000013,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000013, "ssh-agent", "S", "49999"),
          environ: "SSH_AUTH_SOCK=/tmp/agent\0",
          environMode: 0o000,
        },
        {
          // Ancestor/host user namespace viewed from inside `unshare -c -n`: lower UID 4294967295 (unmapped).
          pid: 9000015,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: "0 4294967295 4294967295\n",
          stat: makeStatLine(9000015, "host-proc", "S", "50050"),
          environ: "HOST=1\0",
          environMode: 0o000,
        },
      ],
      sameNsUidMap,
    );

    const minStartFixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-min-start-time"),
      "50000",
      [
        {
          pid: 9000014,
          uids: [myUid, myUid, myUid, myUid],
          stat: makeStatLine(9000014, "agent", "S", "50005"),
          environ: "AGENT=1\0",
          environMode: 0o000,
        },
      ],
    );

    const selfAncestorPid = 9000100;
    const ancestorEntries: FixtureProcEntry[] = [
      {
        pid: 1,
        uids: [otherUid, otherUid, otherUid, otherUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(1, "init", "S", "1", 0),
        environ: "PATH=/usr/bin\0",
      },
      {
        pid: selfAncestorPid,
        uids: [myUid, myUid, myUid, myUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(selfAncestorPid, "shell", "S", "10000", 1),
        environ: "PATH=/usr/bin\0",
      },
    ];

    // Proof 4 (parent chain), cases (a) and (d): proven not ours and skipped cleanly.
    const parentChainSkippedFixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-parent-chain-skipped"),
      "50000",
      [
        ...ancestorEntries,
        {
          // Older non-ancestor parent (e.g. browser running before the test started).
          pid: 9000110,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000110, "browser", "S", "20000", 1),
          environ: "PATH=/usr/bin\0",
        },
        {
          // Newer intermediate parent whose own parent is the older non-ancestor 9000110.
          pid: 9000111,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000111, "zygote", "S", "50010", 9000110),
          environ: "PATH=/usr/bin\0",
        },
        {
          // Case (a): newer unreadable entry whose parent is older than self and not an ancestor.
          pid: 9000051,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000051, "sandbox-a", "S", "50020", 9000110),
          environ: "SANDBOX=1\0",
          environMode: 0o000,
        },
        {
          // Case (d): newer unreadable entry whose parent is newer and grandparent is older non-ancestor.
          pid: 9000054,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000054, "sandbox-d", "S", "50030", 9000111),
          environ: "SANDBOX=1\0",
          environMode: 0o000,
        },
      ],
      sameNsUidMap,
      selfAncestorPid,
    );

    // Proof 4 (parent chain), cases (b), (c), (e), and (f): must stay uncertain and fail cleanup.
    const parentChainUncertainFixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-parent-chain-uncertain"),
      "50000",
      [
        ...ancestorEntries,
        {
          // Newer direct child of the test process (grandparent for case (e)).
          pid: 9000120,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000120, "worker", "S", "50010", process.pid),
          environ: "PATH=/usr/bin\0",
        },
        {
          // Malformed-stat parent (otherUid so outer scan skips 9000132 itself while child 9000058 stays uncertain).
          pid: 9000132,
          uids: [otherUid, otherUid, otherUid, otherUid],
          uidMap: sameNsUidMap,
          stat: "9000132 (broken) S 1 2 3\n",
          environ: "PATH=/usr/bin\0",
        },
        {
          // Unreadable-stat parent (otherUid so outer scan skips 9000133 itself while child 9000059 stays uncertain).
          pid: 9000133,
          uids: [otherUid, otherUid, otherUid, otherUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000133, "locked", "S", "20000", 1),
          statMode: 0o000,
          environ: "PATH=/usr/bin\0",
        },
        {
          // Case (b): parent is the test process.
          pid: 9000052,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000052, "child-b", "S", "50020", process.pid),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (c): parent is an intermediate ancestor of the test process.
          pid: 9000053,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000053, "child-c-anc", "S", "50021", selfAncestorPid),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (c): parent is pid 1 (ancestor of the test process).
          pid: 9000055,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000055, "child-c-pid1", "S", "50022", 1),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (e): parent is newer than the test process and grandparent is the test process.
          pid: 9000056,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000056, "grandchild-e", "S", "50023", 9000120),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (f): parent's stat is absent (pid 9000131 does not exist).
          pid: 9000057,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000057, "orphan-f-absent", "S", "50024", 9000131),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (f): parent's stat is malformed.
          pid: 9000058,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000058, "child-f-malformed", "S", "50025", 9000132),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
        {
          // Case (f): parent's stat is unreadable.
          pid: 9000059,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000059, "child-f-unreadable", "S", "50026", 9000133),
          environ: "HERDR_TEST_TOKEN=tok-parent-uncertain\0",
          environMode: 0o000,
        },
      ],
      sameNsUidMap,
      selfAncestorPid,
    );

    // Proof 4 (parent chain), changed ppid on re-read after parent stat stays uncertain.
    const parentChainChangedPpidFixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-parent-chain-changed-ppid"),
      "50000",
      [
        ...ancestorEntries,
        {
          pid: 9000110,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000110, "browser", "S", "20000", 1),
          environ: "PATH=/usr/bin\0",
        },
        {
          pid: 9000060,
          uids: [myUid, myUid, myUid, myUid],
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000060, "reparented", "S", "50040", 9000110),
          environ: "HERDR_TEST_TOKEN=tok-parent-reparented\0",
          environMode: 0o000,
        },
      ],
      sameNsUidMap,
      selfAncestorPid,
    );

    // Proof 4 (parent chain), 64-step walk cap: 64 steps skips, 65 steps stays uncertain.
    const depthChainEntries: FixtureProcEntry[] = [
      ...ancestorEntries,
      {
        pid: 9000200,
        uids: [myUid, myUid, myUid, myUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(9000200, "older-root", "S", "20000", 1),
        environ: "PATH=/usr/bin\0",
      },
    ];
    for (let i = 1; i <= 64; i += 1) {
      const nodePid = 9000200 + i;
      depthChainEntries.push({
        pid: nodePid,
        uids: [myUid, myUid, myUid, myUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(nodePid, `hop-${i}`, "S", "50010", nodePid - 1),
        environ: "PATH=/usr/bin\0",
      });
    }
    depthChainEntries.push(
      {
        // 65 steps to older non-ancestor 9000200: exceeds 64-step limit -> uncertain.
        pid: 9000061,
        uids: [myUid, myUid, myUid, myUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(9000061, "too-deep", "S", "50050", 9000264),
        environ: "HERDR_TEST_TOKEN=tok-parent-depth\0",
        environMode: 0o000,
      },
      {
        // Exact 64 steps to older non-ancestor 9000200: skipped cleanly.
        pid: 9000062,
        uids: [myUid, myUid, myUid, myUid],
        uidMap: sameNsUidMap,
        stat: makeStatLine(9000062, "at-limit", "S", "50051", 9000263),
        environ: "HERDR_TEST_TOKEN=tok-parent-depth\0",
        environMode: 0o000,
      },
    );
    const parentChainDepthLimitFixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-parent-chain-depth-limit"),
      "50000",
      depthChainEntries,
      sameNsUidMap,
      selfAncestorPid,
    );

    try {
      expect(scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-not-ours", fixture.procRoot)).toEqual({
        matches: [],
        uncertain: [],
      });
      expect(findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-not-ours", fixture.procRoot)).toEqual(
        [],
      );
      expect(
        await stopProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-not-ours", 200, fixture.procRoot),
      ).toEqual([]);

      // Explicit minStartTime boundary: 50005 >= 50000 is uncertain, 50005 < 50010 is proven older.
      expect(
        scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-min", minStartFixture.procRoot).uncertain,
      ).toEqual([{ pid: 9000014, startTime: "50005", reason: "unreadable_environ" }]);
      expect(
        findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-min", minStartFixture.procRoot, {
          minStartTime: "50010",
        }),
      ).toEqual([]);

      // Proof 4 cases (a) and (d): older non-ancestor parent or grandparent skips cleanly.
      const parentSkippedScan = scanProcessesByEnvToken(
        "HERDR_TEST_TOKEN",
        "tok-parent-skip",
        parentChainSkippedFixture.procRoot,
      );
      expect(parentSkippedScan.matches).toEqual([]);
      expect(
        parentSkippedScan.uncertain
          .map((u) => u.pid)
          .sort((a, b) => a - b)
          .join(","),
      ).toBe("");
      expect(parentSkippedScan.uncertain).toEqual([]);
      expect(
        findProcessesByEnvToken(
          "HERDR_TEST_TOKEN",
          "tok-parent-skip",
          parentChainSkippedFixture.procRoot,
        ),
      ).toEqual([]);
      expect(
        await stopProcessesByEnvToken(
          "HERDR_TEST_TOKEN",
          "tok-parent-skip",
          200,
          parentChainSkippedFixture.procRoot,
        ),
      ).toEqual([]);

      // Proof 4 cases (b), (c), (e), and (f): must stay uncertain and fail cleanup.
      const parentUncertainScan = scanProcessesByEnvToken(
        "HERDR_TEST_TOKEN",
        "tok-parent-uncertain",
        parentChainUncertainFixture.procRoot,
      );
      expect(parentUncertainScan.matches).toEqual([]);
      const parentUncertainSorted = [...parentUncertainScan.uncertain].sort(
        (a, b) => a.pid - b.pid,
      );
      expect(parentUncertainSorted).toEqual([
        { pid: 9000052, startTime: "50020", reason: "unreadable_environ" },
        { pid: 9000053, startTime: "50021", reason: "unreadable_environ" },
        { pid: 9000055, startTime: "50022", reason: "unreadable_environ" },
        { pid: 9000056, startTime: "50023", reason: "unreadable_environ" },
        { pid: 9000057, startTime: "50024", reason: "unreadable_environ" },
        { pid: 9000058, startTime: "50025", reason: "unreadable_environ" },
        { pid: 9000059, startTime: "50026", reason: "unreadable_environ" },
      ]);
      expect(() =>
        findProcessesByEnvToken(
          "HERDR_TEST_TOKEN",
          "tok-parent-uncertain",
          parentChainUncertainFixture.procRoot,
        ),
      ).toThrow(/Uncertain process cleanup.*pid=9000052/);
      await expect(
        stopProcessesByEnvToken(
          "HERDR_TEST_TOKEN",
          "tok-parent-uncertain",
          200,
          parentChainUncertainFixture.procRoot,
        ),
      ).rejects.toThrow(/Uncertain process cleanup.*unreadable_environ/);

      // Proof 4 changed-ppid re-read check: child's ppid changes after parent's stat is read.
      const childStatPath = path.join(parentChainChangedPpidFixture.procRoot, "9000060", "stat");
      const parentDirPrefix = `${path.join(parentChainChangedPpidFixture.procRoot, "9000110")}${path.sep}`;
      const parentStatPath = path.join(parentChainChangedPpidFixture.procRoot, "9000110", "stat");
      let childStatReads = 0;
      let nonStatParentReadsDuringWalk = 0;
      const origReadFileSync = fs.readFileSync.bind(fs);
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
        const target = String(args[0]);
        if (target === childStatPath) {
          childStatReads += 1;
          if (childStatReads === 2) {
            return makeStatLine(9000060, "reparented", "S", "50040", 1);
          }
        } else if (
          childStatReads === 1 &&
          target.startsWith(parentDirPrefix) &&
          target !== parentStatPath
        ) {
          nonStatParentReadsDuringWalk += 1;
        }
        return origReadFileSync(...(args as Parameters<typeof fs.readFileSync>));
      }) as typeof fs.readFileSync);
      try {
        const changedPpidScan = scanProcessesByEnvToken(
          "HERDR_TEST_TOKEN",
          "tok-parent-reparented",
          parentChainChangedPpidFixture.procRoot,
        );
        expect(childStatReads).toBe(2);
        expect(nonStatParentReadsDuringWalk).toBe(0);
        expect(changedPpidScan).toEqual({
          matches: [],
          uncertain: [{ pid: 9000060, startTime: "50040", reason: "unreadable_environ" }],
        });
      } finally {
        readSpy.mockRestore();
      }

      // Proof 4 64-step limit: 64 steps skips (9000062), 65 steps stays uncertain (9000061).
      const depthLimitScan = scanProcessesByEnvToken(
        "HERDR_TEST_TOKEN",
        "tok-parent-depth",
        parentChainDepthLimitFixture.procRoot,
      );
      expect(depthLimitScan).toEqual({
        matches: [],
        uncertain: [{ pid: 9000061, startTime: "50050", reason: "unreadable_environ" }],
      });
    } finally {
      fixture.restoreModes();
      minStartFixture.restoreModes();
      parentChainSkippedFixture.restoreModes();
      parentChainUncertainFixture.restoreModes();
      parentChainChangedPpidFixture.restoreModes();
      parentChainDepthLimitFixture.restoreModes();
    }
  });

  test("fixture proc root: malformed or cut-off stat throws in confirmProcessDead and fails env-token cleanup", async () => {
    const myUid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const fixture = createFixtureProcRoot(path.join(scratchRoot, "proc-malformed-stat"), "50000", [
      {
        pid: 9000021,
        uids: [myUid, myUid, myUid, myUid],
        stat: "9000021 (sleep) S 1 2 3 4\n",
        environ: "PATH=/usr/bin\0",
      },
      {
        pid: 9000022,
        uids: [myUid, myUid, myUid, myUid],
        stat: "9000022 (broken S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20\n",
        environ: "PATH=/usr/bin\0",
      },
      {
        pid: 9000023,
        uids: [myUid, myUid, myUid, myUid],
        stat: makeStatLine(9000023, "sleep", "S", "notanumber"),
        environ: "PATH=/usr/bin\0",
      },
      {
        pid: 9000024,
        uids: [myUid, myUid, myUid, myUid],
        stat: "",
        environ: "PATH=/usr/bin\0",
      },
    ]);

    for (const pid of [9000021, 9000022, 9000023, 9000024]) {
      expect(() => confirmProcessDead(pid, "50000", fixture.procRoot)).toThrow(
        /Malformed \/proc stat/,
      );
    }

    const scan = scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-malformed", fixture.procRoot);
    expect(scan.matches).toEqual([]);
    expect(
      scan.uncertain.map((u) => ({ pid: u.pid, reason: u.reason })).sort((a, b) => a.pid - b.pid),
    ).toEqual([
      { pid: 9000021, reason: "malformed_stat" },
      { pid: 9000022, reason: "malformed_stat" },
      { pid: 9000023, reason: "malformed_stat" },
      { pid: 9000024, reason: "malformed_stat" },
    ]);
    expect(() =>
      findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-malformed", fixture.procRoot),
    ).toThrow(/Uncertain process cleanup.*malformed_stat/);
    await expect(
      stopProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-malformed", 200, fixture.procRoot),
    ).rejects.toThrow(/Uncertain process cleanup.*malformed_stat/);
  });

  test("fixture proc root: absent entry or different startTime confirms death while live matching entry stays alive", async () => {
    const myUid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const fixture = createFixtureProcRoot(path.join(scratchRoot, "proc-absent-and-live"), "50000", [
      {
        // Directory exists but stat is absent (ENOENT on stat).
        pid: 9000032,
        uids: [myUid, myUid, myUid, myUid],
      },
      {
        // Valid live stat, absent environ (ENOENT on environ).
        pid: 9000033,
        uids: [myUid, myUid, myUid, myUid],
        stat: makeStatLine(9000033, "exiting", "S", "50020"),
      },
      {
        // Different startTime (PID reused).
        pid: 9000034,
        uids: [myUid, myUid, myUid, myUid],
        stat: makeStatLine(9000034, "reused", "S", "60000"),
        environ: "PATH=/usr/bin\0",
      },
      {
        // Same startTime, live state S.
        pid: 9000035,
        uids: [myUid, myUid, myUid, myUid],
        stat: makeStatLine(9000035, "alive", "S", "50020"),
        environ: "PATH=/usr/bin\0",
      },
      {
        // Same startTime, dead zombie state Z.
        pid: 9000036,
        uids: [myUid, myUid, myUid, myUid],
        stat: makeStatLine(9000036, "zombie", "Z", "50020"),
        environ: "PATH=/usr/bin\0",
      },
    ]);

    // 9000031 has no directory at all (ENOENT).
    expect(confirmProcessDead(9000031, "50020", fixture.procRoot)).toBe(true);
    // 9000032 has directory but no stat file (ENOENT).
    expect(confirmProcessDead(9000032, "50020", fixture.procRoot)).toBe(true);
    // 9000034 has a different startTime (PID reused).
    expect(confirmProcessDead(9000034, "50020", fixture.procRoot)).toBe(true);
    // 9000035 has matching startTime and live state S.
    expect(confirmProcessDead(9000035, "50020", fixture.procRoot)).toBe(false);
    // 9000036 has matching startTime and dead state Z.
    expect(confirmProcessDead(9000036, "50020", fixture.procRoot)).toBe(true);

    // Absent stat/environ entries are skipped cleanly (not uncertain) during env-token scans.
    expect(scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-absent", fixture.procRoot)).toEqual({
      matches: [],
      uncertain: [],
    });
    expect(findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-absent", fixture.procRoot)).toEqual([]);
    expect(
      await stopProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-absent", 200, fixture.procRoot),
    ).toEqual([]);
  });

  test("fixture proc root: root-owned pid directory without readable status UIDs is reported uncertain and fails cleanup", async () => {
    if (typeof process.getuid !== "function" || process.getuid() === 0) {
      return;
    }
    const myUid = process.getuid();
    const rootUid = 0;
    const sameNsUidMap = `${myUid} ${myUid} 1\n`;
    const fixture = createFixtureProcRoot(
      path.join(scratchRoot, "proc-root-owned-dir"),
      "50000",
      [
        {
          // Non-dumpable same-namespace process: root owns /proc/<pid>, status and environ are denied.
          pid: 9000041,
          uids: [myUid, myUid, myUid, myUid],
          statusMode: 0o000,
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000041, "nondump", "S", "50020"),
          environ: "HERDR_TEST_TOKEN=tok-nondump\0",
          environMode: 0o000,
        },
        {
          // Same-namespace process: root owns /proc/<pid>, status omits the four Uid fields.
          pid: 9000042,
          statusRaw: "Name:\tnondump\nState:\tS (sleeping)\n",
          uidMap: sameNsUidMap,
          stat: makeStatLine(9000042, "nondump", "S", "50025"),
          environ: "HERDR_TEST_TOKEN=tok-nondump\0",
          environMode: 0o000,
        },
      ],
      sameNsUidMap,
    );

    const rootOwnedDirs = new Set([
      path.join(fixture.procRoot, "9000041"),
      path.join(fixture.procRoot, "9000042"),
    ]);
    const origStatSync = fs.statSync.bind(fs);
    const statSpy = spyOn(fs, "statSync").mockImplementation(((...args: unknown[]) => {
      const real = origStatSync(...(args as Parameters<typeof fs.statSync>));
      if (
        rootOwnedDirs.has(String(args[0])) &&
        real !== undefined &&
        real !== null &&
        typeof real === "object" &&
        "uid" in real
      ) {
        return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { uid: rootUid });
      }
      return real;
    }) as typeof fs.statSync);

    try {
      const scan = scanProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-nondump", fixture.procRoot);
      expect(scan.matches).toEqual([]);
      const uncertainSorted = [...scan.uncertain].sort((a, b) => a.pid - b.pid);
      expect(uncertainSorted).toEqual([
        { pid: 9000041, startTime: "50020", reason: "unreadable_environ" },
        { pid: 9000042, startTime: "50025", reason: "unreadable_environ" },
      ]);
      expect(() =>
        findProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-nondump", fixture.procRoot),
      ).toThrow(/Uncertain process cleanup.*pid=9000041/);
      await expect(
        stopProcessesByEnvToken("HERDR_TEST_TOKEN", "tok-nondump", 200, fixture.procRoot),
      ).rejects.toThrow(/Uncertain process cleanup.*unreadable_environ/);
    } finally {
      statSpy.mockRestore();
      fixture.restoreModes();
    }
  });
});
