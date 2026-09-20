# AweSam

A small-press journal by Samay Ashar — notes on systems, craft, and learning along the way.

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

- **Digest** (`/digest`) — today’s short mix across every desk
- **Sections** (`/sections`) — five boxes: Articles, Hacker News, X, GitHub, Papers

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

## GitHub Pages

Pushes to `main` deploy to https://samay10.github.io/awesam/
