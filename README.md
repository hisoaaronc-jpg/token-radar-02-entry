# Token Launch Radar

A radar for protocols whose token does not exist yet. It reads a sealed
DefiLlama snapshot (758 protocols, 40 of them on the house watchlist), works
out which of the still-tokenless protocols are worth farming, ranks them by
the implied value of the token they have not launched, and hands the reader a
dashboard: the ranked board, a detail view per protocol with the model's
working shown, filters, and a concrete farm plan on every row.

## The valuation model

Nothing on the board is hand-picked or hand-priced. On every run the model
rebuilds itself from the snapshot it is given:

1. **Learn the multiples.** For each category, take every protocol in the
   snapshot that already has a token and compute its market-cap-to-TVL ratio.
   The category multiple is the median of those ratios, shrunk toward the
   global median (six pseudo-samples) when a category has few live examples,
   and clamped to [0.03, 2.5]. Categories with no live example inherit the
   global median.
2. **Decide who is a launch candidate.** A protocol must record no token
   (no CoinGecko id, no symbol) — and must not be a product of a token that
   already trades: no liquid-staking/restaking or canonical-bridge
   categories, no exchange (CEX) entries, no names carrying *wrapped*,
   *staked* or *staking*, no names beginning with an exchange's name, no
   version-suffixed names, and no bridge entries named as a bare asset
   ticker (that entry is the bridged asset — WBTC, USDT0 — not a protocol).
   Every watchlist protocol passes these tests by construction, and the
   board always carries the whole watchlist.
3. **Price the unlaunched token.** implied value = TVL × category multiple
   × momentum factor × maturity factor. The momentum factor follows the
   7-day TVL change (clamped to −60%…+120%, scaled by 0.45): a protocol
   gaining TVL into a launch is worth more than one bleeding out. The
   maturity factor rises from 0.62 toward 1.00 over the first ~900 days
   DefiLlama has tracked the protocol: survival is evidence.
4. **Rank and explain.** Rows sort by implied value (ties by TVL, then
   slug). Every row carries the factors that produced its number, so the
   dashboard's detail view can show the working, and a 0–100 radar score
   (log-scaled implied value) for a quick read.

On the dev snapshot this produces a 216-row board, watchlist covered 40/40,
topped by Steakhouse Financial, Sentora Curator and Gauntlet.

## Farm plans

Each row's `farm_steps` are generated from a playbook for the protocol's
category (DEX, lending, bridge, yield, staking, derivatives, RWA, chain, or
a generic core loop), filled with that protocol's own chains, TVL and weekly
change, plus rotating wallet-hygiene and campaign-watch steps. The steps are
written for a small, honest, single-wallet farmer: recurring real usage over
6–10 weeks, positions held across snapshots, no sybil behaviour.

## Running it

```
node main.ts --input <path-to-snapshot.json>
```

Output goes to `$MAKEFUN_OUTPUT_DIR` (default `/output`):

- `board.json` — the ranked board (rows carry their farm plans and factors)
- `dashboard/` — `index.html`, `app.css`, `app.js`, plus a `data.js`
  generated from this run's board so the page always renders the board it
  ships with; open `index.html` in any browser, no network needed
- `screenshots/` — board, detail and filtered views of the dashboard
- `dossier.json` — the makefun/dossier/v1 dossier of the dashboard and
  screenshots, built by `lib/dossier.ts`

Node 22, standard library only. Two runs on the same snapshot produce
byte-identical outputs.

## Layout

- `main.ts` — entry point: snapshot in, board + dashboard + dossier out
- `lib/model.ts` — eligibility, the valuation model, farm-plan generation
- `lib/dossier.ts` — the dossier builder (canonical JSON, source listing
  cut to the 65,536-byte text budget by the published cut rule)
- `dashboard/` — the reader-facing page (source of the screenshots)
- `screenshots/` — the three views the dossier carries

## License

MIT — see `LICENSE`.
