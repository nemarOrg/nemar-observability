export function normalizeCountryName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

export function buildCountryNameIndex(
  countryNamesByCode: Readonly<Record<string, readonly string[]>>,
): Record<string, string> {
  const index = Object.create(null) as Record<string, string>;
  const candidatesByName = new Map<string, Set<string>>();
  for (const [candidate, names] of Object.entries(countryNamesByCode)) {
    const code = candidate.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) continue;
    for (const name of names) {
      const normalizedName = normalizeCountryName(name);
      if (!normalizedName) continue;
      const candidates = candidatesByName.get(normalizedName) ?? new Set<string>();
      candidates.add(code);
      candidatesByName.set(normalizedName, candidates);
    }
  }
  for (const [name, codes] of candidatesByName) {
    if (codes.size === 1) {
      const [code] = codes;
      if (code) index[name] = code;
    }
  }
  return index;
}
