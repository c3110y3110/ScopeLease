# Frozen evaluation evidence

This directory keeps paper-facing evidence that must remain available from a clean source checkout.
Generated runtime outputs still live under `.scopelease/`, but `.scopelease/` is local state and is not a reliable source package boundary.

Included snapshots:

- `formal-command-100pair-mini-20260521-133429/product-wide-summary.json`: product-wide paired evidence summary consumed by `npm run paper:report:full`.
- `delegation-control-source-of-truth-20260528/`: last generated delegation-control report JSON, Markdown, and manifest for reviewer inspection.

Regeneration:

- `npm run paper:report:controlled` regenerates the controlled mechanism report without product-wide summary input.
- `npm run paper:report:full` regenerates the full source-of-truth report using the frozen product-wide summary above.
- `node src/cli.js freeze-evidence . --format json` copies the regenerated source-of-truth report back into this frozen evidence directory.
- `npm run paper:verify:frozen` verifies the current frozen headline metrics and path hygiene.
- `npm run paper:source-zip` and `npm run paper:verify:source-zip` build and inspect the anonymous clean source archive.
