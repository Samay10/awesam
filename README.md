# Prodigy

Technical digest — systems architecture, mathematical precision, foundational AI research, and programming craft.

Live at **https://www.prodigy.org.in** (GitHub Pages custom domain). The old path `https://samay10.github.io/awesam/` still builds from this repo but the site base is now `/`.

## Stack

Astro + Tailwind. Live wires enrich at build time via Groq.

## On-site briefings

Cards do **not** paste the original post. On every refresh the build:

1. Pulls the live wires
2. Asks Groq **Llama 3.3 70B** (free tier; falls back to GPT-OSS / Qwen if needed) for an original lede + **3–4 minute** author-style technical note (≥4 paragraphs + takeaway)
3. Publishes an on-site page at `/reads/<id>/` with a link back to the original at the end

Images are off for now — text quality first.

Set `GROQ_API_KEY` locally in `.env` and as a GitHub Actions secret named **`GROQ_API_KEY`**.

## Custom domain

`public/CNAME` is set to `www.prodigy.org.in`. In DNS:

- **www** → `CNAME` to `samay10.github.io`
- **apex** (`prodigy.org.in`) → `A` records to GitHub Pages IPs, or a redirect/CNAME flattening to www

Enable “Enforce HTTPS” in the repo Pages settings after DNS propagates.

## GitHub Pages

Pushes to `main` (and a 6-hour cron) deploy from this repository.
