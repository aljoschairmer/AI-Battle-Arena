# Audit history — condensed

One-page summary of the five engine/brain improvement passes that used to live
as 17 files under `docs/audit/`. The full phase-by-phase documents remain
available in git history (last present at the commit that removed them); this
file keeps only what a reader needs today: what each pass found, what shipped,
and what was measured.

## Pass 1 — engine behavior audit (phases 1–5)

Static behavior-by-behavior trace, then per-tick telemetry
(`telemetryLog.ts` + `analyze-telemetry.ts`), then six ranked fixes — all
implemented as clamped `EnginePolicy` knobs, no controller priority
reordering:

- Threat-aware zone-return (was a blind `move_to` zone centre through enemy
  coverage) and trade-aware retreat (HP threshold alone used to trigger it).
- Defensive shove/grapple, threat-aware cooldown step, target-switch
  hysteresis, dagger flank deferral, `disengageHpThreshold`,
  `targetMatchupWeight`.
- Follow-up deep dive: zone-edge-drift vs combat oscillation — 27% of
  engagements were interrupted by the zone-drift branch; resolved with a
  graduated margin (fixed, regression-tested in smoke).
- Phase 5 extended the audit beyond the engine (brain, transport, bus,
  config, bootstrap) and hardened payload validation/freshness handling.

## Pass 2 — second engine audit

Re-audit targeting what pass 1's simulator never exercised (non-sword
weapons, pickups, hazards). Headline findings, all fixed:

- Daggers flank orbit dealt zero damage (the flank deferral could starve the
  attack forever).
- `action_issued` choke-point telemetry added in `Controller.decide()` —
  revealed shove-cooldown spam and gravity-well casts without a collected
  charge; both gated (server-echoed counts preferred over local belief).

## Pass 3 — production fleet + win-rate pass

First live multi-bot deployment (3 bots, full LLM brains, BOT_COOP). Two
tracks:

- **Friendly fire → 0:** ten distinct teammate-kill channels found live and
  closed one by one (cleave arcs, fire lanes, AoE placement, grapple pulls,
  mine broadcasting + rerouting, pack spacing, autopilot downgrades).
- **Win-rate measurement infra:** persistent `outcomes.jsonl` outcome log,
  cause-of-death classification, `POLICY_VARIANT` A/B tagging, and
  evidence-based drafting (fleet weapon win rates override both the LLM and
  the deterministic fallback; a live A/B killed the zone-endgame posture —
  0/18 vs 7/22 wins, Fisher p≈0.01, now default-off).

## Pass 4 — live API surface audit

Diffed the bot's protocol types against the real `arena.angel-serv.com`
surface. All findings fixed same-day: hazard-zone entities + pulse timing,
bounty beacon / `is_bounty_target`, server-echoed gravity/mine counts,
sudden-death void refresh, spectator-feed global intel (mines, aggro graph,
hunters), capture-pad state machine, armed teleport pads excluded from safe
steps, full `/arena/map` objective ingest.

## Pass 5 — external review ("the roast") remediation

Security and hygiene pass driven by an external code review: corporate cert
removed from the tree (history scrub documented in `SECURITY.md`), git push
moved out of the shutdown path onto a background schedule, crash handlers
changed from log-and-continue to graceful shutdown + supervisor restart,
telemetry integrity fixes (`ticksSurvived` round-relative + clamped, real
`hpAtDeath`, ghost killers labelled as environment), Vitest unit suite + CI,
grid-size-derived pathfinding keys, and this compression of the audit diary.

## Cumulative measured results

- 629 logged rounds vs the production arena's house bots: fleet win rate
  ~6% → **20%** over the latest window (15-bot FFA ⇒ ~7% uniform chance);
  ELO 119 → 250+.
- Weapon evidence beats tier lists: bow 23% win rate where daggers ran 3%.
- Friendly fire: 51 teammate kills investigated → 0 after the ten guards.

Method details and the measurement tooling: `docs/fight-summary.md`,
`scripts/analyze-outcomes.ts`, `scripts/analyze-telemetry.ts`.
