-- Data migration: any translation where source == target (non-empty) and state is
-- 'needs-translation' or 'new' was almost certainly a BC Xliff Generator placeholder copy.
-- Treat those as already-translated (proper nouns, abbreviations, codes, etc.).
UPDATE "Translation"
SET state = 'translated', "updatedAt" = CURRENT_TIMESTAMP
WHERE source = target
  AND target != ''
  AND state IN ('needs-translation', 'new');
