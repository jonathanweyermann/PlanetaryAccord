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

## 2026-11-26 — Iterations 2–3 (same session)

### Peacetime trade diplomacy (verified in browser + headless)
- **Problem.** Diplomacy only offered ceasefires during incidents or wars; at peace the dialog's only button was "Declare War…". AI colonies also never met each other: on seed 2220413130 there was zero contact in 25 game minutes, because AI scouts only patrolled 22 units from home while factions start 100+ apart.
- **Change.** Factions at peace can now trade. The AI judges offers by how scarce each resource is to it and won't drain its own reserves. Every ~75s an AI faction may propose a trade that covers its biggest shortage, paid from its largest surplus. Ignored proposals expire after 60s. AI scouts range steadily farther after 90s.
- **Headless evidence.** On the same seed, AI factions made contact and completed about a dozen trades in 25 min, and Forge and Drift became Friendly through trade.
- **Browser evidence.** I sent a scout and made contact with Drift. Diplomacy then offered "Propose Trade", and the live estimate said "Likely to accept. A generous exchange." I sent 30 metal for 30 energy and got "Trade completed": metal 65 → 35, energy 74 → 104, their opinion 0 → +3.
- **Not verified in the browser.** I didn't see an incoming AI → player trade proposal; the AI correctly didn't ask, because I had nothing spare. It reuses the existing incoming-offer panel, with new wording.
- **Regression found and fixed.** Trades were counted as treaty "agreements", and those permanently block AI aggression, so trading partners could never fight again. Trades now have their own counter with a capped de-escalation effect. A test was added.

### Audio settings persist
- The Music and Sound effects toggles reset to on after every reload. They are now saved in localStorage, which I verified across a reload.

### Tests
60/60 pass.

### Remaining weaknesses
- **AI aggression is very low.** No AI faction comes near the intrusion threshold of 37 in 40 minutes; the most aggressive pairing, Drift → Meridian, peaks at about +15. This was true before the trade work. AI wars are effectively absent, so the "potential warfare" half of the faction simulation needs tuning, ideally with playtesting over long games.
- Number keys 1–6 start building placement.
- AI → player trade proposals only show up as a badge on the Diplomacy button; a toast might make them easier to notice.

## 2026-11-26 — Iteration 4: AI faction aggression

### Diagnosis (headless 40-minute runs; the score is intrusionScore, where 37 triggers an incursion)
- **The AI cast never changed.** Personalities were fixed per faction, so every seed had balanced, commercial, defensive and expansionist rivals, and militaristic and opportunistic never appeared. That hurt both replayability and conflict.
- **The land motive was dead.** territorialValue only counted rival deposits within about 70 units of the faction's own home; colonies are 120+ apart, so it was always 0.
- **Army size didn't matter.** Only the strength *ratio* mattered, so Drift growing from 340 to 1,542 strength barely changed its intent.

### Changes
- Personalities are drawn per seed from thematic pools. A separate random stream keeps terrain identical, which I checked: same homes and same maps for the known seeds. Across 60 seeds the distribution matched the intended weights.
- Rival deposits are valued relative to the distance between colonies.
- A large standing army makes aggressive leaders "restless".
- Repeated deliberate withdrawals deter further probing but harden resolve, so a determined aggressor eventually escalates.
- A collapsing faction (command centre below 60%) sues for peace every 25s instead of every 120s, with a larger tribute.
- Settlement grace: no deliberate incursions in the first 8 minutes. In a browser playtest *before* this change, Drift probed my colony at 3:07, while I was still on tutorial step 1.
- Wars, ceasefires and defeats between other factions now reach anyone who knows either side, as "News:" lines in the field log.

### Evidence
- **Seed 2220413130:** 3 incidents at 11, 17 and 25 min, each resolved by a compensated ceasefire, plus 20 trades. Third parties received the News lines.
- **Seed 3921109754:** militaristic Forge probes Drift at 21 min, withdraws, probes again at 23 min, and goes to war. Before the withdrawal rule, it probed and withdrew 11 times in a row.
- **Seed 12345:** a peaceful mix, with no incidents.
- 64/64 tests pass. In the browser, the game loads with no console errors after the changes.
- I didn't see a News line in the browser. The browser run happened before the broadcast existed, and the pane was hidden (a throttled background tab: only 5:22 of game time in about 3 real minutes at 4×). News is covered by a unit test and the headless runs.

### Remaining weaknesses
- **Wars are decisive and abrupt.** On seed 3921109754, Drift's command centre went from healthy to destroyed in about 1 second, and the faction was eliminated 53s after war was declared. Peace bids come too late. Defence, command-centre durability and attack pacing need a closer look with a visible browser pane.
- Effective game speed in a hidden browser pane is far below the selected speed. Performance in a visible pane is unmeasured.
- Number keys 1–6 start building placement.
