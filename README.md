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

Placeholder digest cards live in `src/data/digest.ts` until live APIs are wired.

## GitHub Pages

Pushes to `main` deploy to https://samay10.github.io/awesam/
