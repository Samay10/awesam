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
- GitHub / arXiv / X — same rebuild cadence

GitHub Actions redeploys on every `main` push and on a **6-hour cron** (`0 0,6,12,18 * * *` UTC), so the site refreshes four times a day.

## GitHub Pages

Pushes to `main` (and the schedule above) deploy to https://samay10.github.io/awesam/
