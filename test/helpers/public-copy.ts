// Words that must not appear in reader-facing metric copy. Shared so the
// source scan in public-copy.test.ts and tests that render conditional hints
// apply the same rule.
export const JARGON =
  /Cloudflare|\bS3\b|CloudWatch|presigned|index\.json|nemar approve|archive-sweep|#\d{3}|source='|\b\d+d\b|—/;
