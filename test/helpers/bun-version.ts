export const MIN_BUN_VERSION = "1.4.0";

const MIN_BUN_PARTS: readonly [number, number, number] = [1, 4, 0];

/**
 * Throws unless `version` starts with three dot-separated numbers at or above `1.4.0`.
 * Trailing text after the three numbers is ignored.
 */
export function assertSupportedBunVersion(version: string): void {
  const match = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  if (!match) {
    throw new Error(
      `Bun ${MIN_BUN_VERSION} or newer is required to run this test suite; could not parse Bun version ${JSON.stringify(version)}.`,
    );
  }
  const parts: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  if (!parts.every((part) => Number.isSafeInteger(part))) {
    throw new Error(
      `Bun ${MIN_BUN_VERSION} or newer is required to run this test suite; could not parse Bun version ${JSON.stringify(version)}.`,
    );
  }
  for (let i = 0; i < MIN_BUN_PARTS.length; i += 1) {
    const actual = parts[i]!;
    const required = MIN_BUN_PARTS[i]!;
    if (actual > required) {
      return;
    }
    if (actual < required) {
      throw new Error(
        `Bun ${MIN_BUN_VERSION} or newer is required to run this test suite; found ${JSON.stringify(version)}.`,
      );
    }
  }
}
