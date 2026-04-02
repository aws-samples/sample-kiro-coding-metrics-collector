// semver 版本比较工具

export type SemverPart = number | string;

interface ParsedSemver {
  core: number[];
  prerelease: SemverPart[];
}

function toNumeric(value: string): SemverPart {
  const numeric = Number(value);
  return Number.isNaN(numeric) ? value : numeric;
}

export function parseSemver(version: string): ParsedSemver {
  const trimmed = version.trim().replace(/^v/i, "");
  const [corePart = "", preReleasePart = ""] = trimmed.split("-", 2);
  const [coreOnly] = corePart.split("+", 2);
  const [preReleaseOnly] = preReleasePart.split("+", 2);

  const coreSegments = coreOnly
    .split(".")
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10))
    .map((v) => (Number.isNaN(v) ? 0 : v));

  const prereleaseSegments = preReleaseOnly
    .split(".")
    .filter((s) => s.length > 0)
    .map(toNumeric);

  return { core: coreSegments, prerelease: prereleaseSegments };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const av = pa.core[i] ?? 0;
    const bv = pb.core[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }

  // 无 prerelease 的版本 > 有 prerelease 的版本
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const plen = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < plen; i++) {
    const av = pa.prerelease[i];
    const bv = pb.prerelease[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const aNum = typeof av === "number";
    const bNum = typeof bv === "number";
    if (aNum && bNum) return (av as number) > (bv as number) ? 1 : -1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return (av as string) > (bv as string) ? 1 : -1;
  }
  return 0;
}

export function isVersionSatisfied(actual: string, minimum: string): boolean {
  return compareSemver(actual, minimum) >= 0;
}
