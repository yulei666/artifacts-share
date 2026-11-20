// @ts-check

const MARKDOWN_INDEXES = ['index.md', 'index.markdown', 'readme.md', 'readme.markdown'];
export const MARKDOWN_INDEX_MAX_LENGTH = Math.max(...MARKDOWN_INDEXES.map((name) => name.length));

/**
 * Finds the preferred Markdown index among the direct children of a directory prefix.
 * @param {string[]} paths
 * @param {string} [prefix]
 * @returns {string | null}
 */
export function pickMarkdownIndex(paths, prefix = '') {
  let best = null;
  let bestRank = MARKDOWN_INDEXES.length;
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rank = MARKDOWN_INDEXES.indexOf(path.slice(prefix.length).toLowerCase());
    if (rank < 0 || rank > bestRank) continue;
    if (rank < bestRank || best === null || path < best) {
      best = path;
      bestRank = rank;
    }
  }
  return best;
}
