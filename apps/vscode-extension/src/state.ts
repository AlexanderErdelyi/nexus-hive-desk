/**
 * Shared extension state accessible by all modules without circular imports.
 * Key: document URI string → Value: initial search filter to apply when the
 * Nexus editor opens that document (set by findInNexus / openInNexus commands).
 */
export const pendingFilters = new Map<string, string>();
