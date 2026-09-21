# AweSam

Technical digest by Samay Ashar — systems, craft, and research notes.

This repo is **blog only**. The personal portfolio lives in the sibling folder `../portfolio` (GitHub: `Samay10/samay-portfolio`).

## Local development

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
npm run preview
```

## Navigation

- **Digest** (`/digest`) — The Technical Digest (2·2·3·3 bands)
- Segmented feeds — HN · X · GitHub · Papers

## Writing

Add Markdown files under `src/content/posts/` with frontmatter:

```md
---
title: Your title
description: One-line summary
pubDate: 2026-09-19
tags:
  - systems
draft: false
---
```

Placeholder cards in `src/data/digest.ts` are only used if live wires fail at build time.

## Live wires

Build-time fetches (no manual daily edits):

- **Hacker News** — official Firebase API [`beststories`](https://github.com/HackerNews/API), soft-filtered toward systems/AI titles
- **X** — no free official API; curated AI/systems handles via [FxEmbed RSS](https://docs.fxembed.com/guide/advanced/rss-atom-feeds/), ranked for AI · systems · hardware · software relevance
- **GitHub** — hottest rising repos at build time; live PR pulse on `/sections/github` polls flagship repos in the browser every **5 minutes**
- **Papers** — arXiv preprints + [OpenAlex](https://openalex.org/) scholarly index for NeurIPS / ICLR / ICML / ACL / AAAI / EMNLP and top labs (OpenAI, DeepMind, Google, Meta, Stanford, MIT, Berkeley, MSR). ResearchGate and Google Scholar have no public API, so OpenAlex is the open replacement covering the same literature.

GitHub Actions redeploys on every `main` push and on a **6-hour cron** (`0 0,6,12,18 * * *` UTC), so papers refresh well within a **24-hour** window. The GitHub PR pulse refreshes itself in-page without a redeploy.

## GitHub Pages

Pushes to `main` (and the schedule above) deploy to https://samay10.github.io/awesam/
