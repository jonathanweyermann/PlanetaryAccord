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

## 2026-11-26 — Run #1, continued (user allowed the dev server)

The game was played in the browser pane at `http://localhost:8000/?seed=2220413130` (the `?seed=` parameter makes reloads reproducible). `.claude/launch.json` is committed so future runs can start the server.

### Baseline (observed in ~10 min of play; only scored where I saw evidence)
| Category | Score | Evidence |
|---|---|---|
| Graphics & environment | 7 | Strong stylised look: dense forest, readable command centre, clean labels. |
| Visual consistency | 7 | HUD, labels and minimap share one coherent palette. |
| UI & usability | 5 | Polished panels, but the first tutorial step could stall (bug 1). Hotkeys 1–6 are build shortcuts, which is easy to hit by accident. |
| Resource gathering & economy | 4 → 6 | Harvesting stalled (bug 1). Food drained to 0 silently with no consequence (bug 2). Both are fixed. |
| Combat, AI factions, diplomacy, performance, replayability | not scored | Not reached in play yet. |

### Fixes (both verified in the browser)
1. **Harvest click became an assist order.** After one rover parked on the Iron Deposit, right-clicking the deposit picked that rover and gave "Rovers assigned to assist", so metal never rose and the tutorial stayed at 0/10. Harvest now takes priority when a resource is under the cursor, and rovers never assist a rover in their own selection. Before the fix, metal stayed at 65 for 4+ minutes. After it, the game said "3 rovers harvesting metal", metal rose 65 → 124 and the tutorial step completed.
2. **Food warning and famine.** The game now warns at <20 food, with the time left ("Food reserves are running low (112s left)…"). While stores are empty, one colonist leaves every 30s, down to a minimum of max(4, unit count). Observed in-game: departures at 5:18 and 5:48, population 10 → 8. A unit test was added. 54/54 tests pass.

### Remaining weaknesses / next candidates
- Number keys 1–6 start building placement; a player expecting speed or control-group keys gets surprised.
- AI factions don't trade or build friendships on their own outside a conflict (see code-review note above). This is the top non-combat candidate.
- Mid-game combat, AI expansion and diplomacy haven't been playtested yet.
