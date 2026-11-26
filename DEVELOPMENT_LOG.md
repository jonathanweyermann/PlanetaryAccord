# Planetary Accord — Development Log

## 2026-11-26 — Nightly run #1 (blocked: no browser access)

### What happened
- The scheduled run couldn't open the game. Starting `serve.py` through the browser pane was declined, and opening the offline build (`Planetary Accord.html`) over `file://` was also refused.
- Because the run was unattended, I didn't work around either refusal. That means there was no playtest, no screenshots and no visual inspection this run.
- The task rules forbid claiming untested improvements, so I made **no gameplay changes**. Unverified blind edits would have broken that rule.

### What was verified
- `node --test`: 53/53 tests pass (world + diplomacy).
- `python tools/build-offline.py` rebuilds `Planetary Accord.html` reproducibly (no diff against the committed file).

### Baseline scores
No baseline scores yet. Scoring graphics, UI, animation, pathfinding feel, combat feedback, atmosphere and performance needs a real playtest, and these will be filled in on the first run that can launch the game.

### Code-review observations (to check in play next run)
- Diplomacy AI (`diplomacy-ai.mjs`) handles border incidents, demands, tribute, ceasefire and peace offers well, with six personalities.
- AI factions don't seem to trade or form friendships on their own initiative outside a conflict. `STANCE.FRIENDLY`/`ALLIED` exist, but `advanceDiplomaticAI` only acts on incidents and wars. This is the leading candidate for a high-impact non-combat improvement ("combat should not be the only meaningful mechanic").

### To unblock the next run
- Allow the browser pane to run `python serve.py --port 8000` (a `.claude/launch.json` entry), or allow `file://` access to the project folder, so the game can be played and screenshotted.
