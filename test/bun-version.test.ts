import { describe, expect, test } from "bun:test";
import { assertSupportedBunVersion } from "./helpers/bun-version.ts";

assertSupportedBunVersion(Bun.version);

describe("Runtime version guard", () => {
  test("assertSupportedBunVersion accepts 2^53 - 1 and refuses 2^53 in each version number", () => {
    const cases: readonly { accepted: string; refused: string }[] = [
      { accepted: "9007199254740991.0.0", refused: "9007199254740992.0.0" },
      { accepted: "1.9007199254740991.0", refused: "1.9007199254740992.0" },
      { accepted: "1.4.9007199254740991", refused: "1.4.9007199254740992" },
    ];

    for (const { accepted, refused } of cases) {
      expect(() => assertSupportedBunVersion(accepted)).not.toThrow();
      const escaped = JSON.stringify(refused).replaceAll(".", "\\.");
      expect(() => assertSupportedBunVersion(refused)).toThrow(
        new RegExp(`1\\.4\\.0.*could not parse Bun version ${escaped}`),
      );
    }
  });

  test("assertSupportedBunVersion refuses 1.3.100 as below 1.4.0", () => {
    expect(() => assertSupportedBunVersion("1.3.100")).toThrow(
      /1\.4\.0.*found "1\.3\.100"/,
    );
  });
});
