// Pure string-similarity helpers used by Translation Memory fuzzy matching.
// Deliberately free of any VS Code API imports so it can be unit-tested in plain Node.

/** Classic Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Normalised similarity score in the range [0, 1].
 *  - 1 only for an exact case-sensitive match.
 *  - Case-insensitive fuzzy matches are capped at 0.99 so they never read as "100%".
 *  - Strings whose lengths differ by more than 40% short-circuit to 0.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;                        // exact case-sensitive match → 100%
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  // Quick length-ratio pre-filter: if strings differ in length by >40%, Levenshtein
  // score can never reach FUZZY_THRESHOLD (0.75), so skip the expensive computation.
  const minLen = Math.min(a.length, b.length);
  if (minLen / maxLen < 0.6) return 0;
  // Case-insensitive fuzzy score, capped at 0.99 so it never shows as "100%" when case differs
  const fuzzy = 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
  return Math.min(fuzzy, 0.99);
}

/** Minimum similarity for a TM entry to be considered a fuzzy match. */
export const FUZZY_THRESHOLD = 0.75;
