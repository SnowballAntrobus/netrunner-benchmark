# D17 — The project site (GitHub Pages)

**Status: implemented** (publishing is a manual workflow run, see
below) · A public page for the project, in the same article style as the
author's [symmetry-follow](https://github.com/SnowballAntrobus/symmetry-follow)
site: what the benchmark is, a recorded game to watch, how the harness
works, the results so far, and how to reproduce them. The results
discussion is left to the author.

## Layout (`site/`)

```
site/
  index.html          the article: Introduction · Watch a game · How it
                      works · Results · Reproduce · References
  assets/styles.css   light article system (serif headings, wide figures)
  assets/site.mjs     renders the gallery, results table and pool summary
                      from data/index.json
  viewer/             the D15 board viewer (also used by `replay` and live)
  data/               GENERATED, gitignored: index.json + one viewer bundle
                      per corpus game (data/games/<game_id>.json)
```

Static files only: no build step, no framework, no external requests.
The featured game is embedded with an iframe of the viewer; every other
corpus game is a card in the gallery and a row in the results table,
each opening the viewer full screen.

## Data, always derived from the corpus

`npx tsx src/cli.ts site` builds `site/data/` from the tracked corpus
(`harness/data/games/`): a viewer bundle for every game that has frames,
and `index.json` with one entry per game (seats and models, matchup,
seed, outcome, agenda points, turns, API decisions, cost, interface era)
plus the card-pool qualification summary from `harness/fixtures/pool.json`
(D16). The data is never committed: the Pages workflow rebuilds it on
every publish, so the site cannot drift from the records.

Results are grouped by interface era, and the page says games are only
comparable within an era. The current corpus predates era 4, so the
Results section opens with a "Preliminary" note; the discussion below
the table is an HTML comment placeholder for the author.

## Publishing

`.github/workflows/pages.yml` ("Publish GitHub Pages") runs on manual
dispatch from the default branch: `npm ci`, `cli.ts site`, then uploads
`site/` with the official Pages actions. One-time repository setup:
**Settings → Pages → Build and deployment → Source: GitHub Actions**.
To publish on every push instead, add a `push` trigger for `dev` limited
to `site/**` and `harness/data/games/**` (the workflow file has it
commented).

Local preview:

```sh
npx tsx src/cli.ts site --serve     # http://127.0.0.1:8788/site/
```

## Checks (met)

- Desktop and phone widths: no horizontal page scroll; the results table
  scrolls inside its own region; the pipeline figure reflows to a
  column.
- Gallery, table and pool summary render from `index.json`; the page
  shows a readable message if the data is missing.
- Every gallery card and table row opens a working viewer bundle.

## Non-goals

Analysis and charts (the author's), a custom domain, and per-game pages
beyond the viewer.
