/**
 * Shared extension state accessible by all modules without circular imports.
 * Key: document URI string → Value: initial search filter to apply when the
 * Nexus editor opens that document (set by findInNexus / openInNexus commands).
 */
export const pendingFilters = new Map<string, string>();

/**
 * Optional initial search text to pre-fill the search box when a panel opens.
 * Key: document URI string → Value: search text (e.g. a Caption value).
 */
export const pendingSearches = new Map<string, string>();
