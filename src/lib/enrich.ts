import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DigestSource } from '../data/digest';
import { CATALOG_PATH, storySlug, type Story, type StoryCatalog } from './catalog';
import { TEXT_MODEL, chatCompletion, hasTextKey } from './ai';
import {
	fetchHackerNews,
	fetchHottestGithubToday,
	fetchPapers,
	fetchPressNews,
	fetchRedditTech,
	fetchXTimeline,
	type FeedItem,
} from './feeds';

/** Bump to invalidate prior prompt caches. */
const PROMPT_VERSION = 'v4-voice';

const CACHE_DIR = path.join(process.cwd(), '.cache/stories');
const TEXT_CONCURRENCY = 1;

const SHARED_RULES = `You write for AweSam — a technical digest read by young engineers, builders, and AI/systems people.

Voice: technical-author energy. Informal is fine. Sound like a sharp human who ships code — not a summarizer bot, not a PR intern.

Hard bans:
- Never meta-comment on the post ("This post…", "This tweet…", "This HN thread…", "sounds like…", "reads as…").
- No AI slop: delve, landscape, robust, leverage, unlock, empower, game-changer, "in today's world", "it's important to note", "A closer look at", "on the wire", "source of truth".
- Do not invent numbers, quotes, authors, or results missing from the notes.
- Never copy the source verbatim. Rewrite.

Return ONLY valid JSON (no markdown fences):
{
  "lede": "card blurb",
  "whyRead": "one sentence",
  "paragraphs": ["...", "..."]
}`;

const DESK_BRIEF: Record<DigestSource, string> = {
	hn: `Desk: Hacker News.
Write a cool 2–3 minute read (~320–450 words, 3–5 short paragraphs).
Lead with the tech itself — what broke, shipped, or got argued.
Bring in the shape of the discussion (camps, caveats, what people are checking) without saying "this post" or "this thread".
Card lede: 45–70 words, concrete stakes.`,
	x: `Desk: X.
Keep it simple and to the point. 2–3 short paragraphs (~180–280 words total).
Say what the person claimed or shipped. No fluff. No "this tweet".
Card lede: 30–45 words, punchy.`,
	press: `Desk: tech press (WIRED / TechCrunch / The Verge).
2–3 minute read. Lead with the product, company, or tech claim. Keep it skeptical and concrete.
Card lede: 45–70 words.`,
	reddit: `Desk: Reddit.
2–3 minute read on the idea people are chewing on. Technical, a bit informal. Skip meme voice.
Card lede: 40–60 words.`,
	github: `Desk: rising GitHub repo.
What it does, who it's for, why stars are moving. Builder voice.
Card lede: 40–60 words.`,
	papers: `Desk: research paper.
Problem → approach → why a practitioner should care. Faithful to the abstract.
Card lede: 45–70 words.`,
	articles: `Desk: article.
Argument + stakes for a young engineer. Card lede: 45–70 words.`,
};

type Draft = {
	lede: string;
	whyRead: string;
	paragraphs: string[];
};

type CacheRow = {
	id: string;
	title: string;
	version: string;
	draft: Draft;
};

function statsFromMeta(meta: string) {
	return meta
		.split('·')
		.map((part) => part.trim())
		.filter(Boolean);
}

function minutesFor(paragraphs: string[]) {
	const words = paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
	return Math.max(2, Math.min(3, Math.round(words / 180) || 2));
}

const SLOP =
	/A closer look at|on the wire|live signal is thin|model was unavailable|This (post|tweet|thread|story|article)|sounds like|reads as|delve|game-changer|in today's|source of truth|it's important to note/i;

function isWeakDraft(draft: Draft | null | undefined, title: string) {
	if (!draft?.lede || draft.paragraphs.length < 2) return true;
	if (SLOP.test(draft.lede) || draft.paragraphs.some((p) => SLOP.test(p))) return true;
	if (draft.lede.includes(title) && draft.lede.length < title.length + 40) return true;
	return false;
}

function extractJson(text: string): Draft | null {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Draft>;
		const paragraphs = Array.isArray(parsed.paragraphs)
			? parsed.paragraphs.map((p) => String(p).trim()).filter(Boolean)
			: [];
		if (!parsed.lede || paragraphs.length < 2) return null;
		return {
			lede: String(parsed.lede).trim(),
			whyRead: String(parsed.whyRead ?? '').trim(),
			paragraphs,
		};
	} catch {
		return null;
	}
}

async function readCache(id: string): Promise<CacheRow | null> {
	try {
		const raw = await readFile(path.join(CACHE_DIR, `${id}.json`), 'utf8');
		return JSON.parse(raw) as CacheRow;
	} catch {
		return null;
	}
}

async function writeCache(row: CacheRow) {
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(path.join(CACHE_DIR, `${row.id}.json`), JSON.stringify(row, null, 2));
}

function buildUserPrompt(item: FeedItem, source: DigestSource) {
	return [
		`PROMPT_VERSION: ${PROMPT_VERSION}`,
		`Story id: ${item.id}`,
		`Source desk: ${source}`,
		`Source label: ${item.source}`,
		`Title: ${item.title}`,
		item.summary ? `Source notes:\n${item.summary}` : 'Source notes: title/meta only — do not invent details.',
		item.meta ? `Signals: ${item.meta}` : '',
		`URL (orientation only): ${item.href}`,
		DESK_BRIEF[source],
		`Write like a technical author for young engineers. Informal OK. Zero meta commentary about "the post".`,
	]
		.filter(Boolean)
		.join('\n\n');
}

async function draftFromModel(item: FeedItem, source: DigestSource): Promise<Draft | null> {
	const maxTokens = source === 'x' ? 900 : 1800;
	try {
		const raw = await chatCompletion(
			[
				{ role: 'system', content: SHARED_RULES },
				{ role: 'user', content: buildUserPrompt(item, source) },
			],
			{ maxTokens, temperature: 0.6, json: true },
		);
		const parsed = extractJson(raw);
		if (!parsed || isWeakDraft(parsed, item.title)) {
			console.warn(`[enrich] weak draft for ${item.id}; retrying once`);
			const retry = await chatCompletion(
				[
					{ role: 'system', content: SHARED_RULES },
					{
						role: 'user',
						content: `${buildUserPrompt(item, source)}\n\nPrevious draft was too meta or generic. Rewrite: lead with the tech, no "this post/tweet" framing.`,
					},
				],
				{ maxTokens, temperature: 0.7, json: true },
			);
			const second = extractJson(retry);
			if (!second || isWeakDraft(second, item.title)) return null;
			return second;
		}
		return parsed;
	} catch (error) {
		console.warn(`[enrich] text failed for ${item.id}:`, error instanceof Error ? error.message : error);
		return null;
	}
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const index = cursor++;
			out[index] = await fn(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return out;
}

function badgeFor(source: DigestSource, item: FeedItem) {
	if (source === 'hn') return 'HN · Best';
	if (source === 'github') return 'GitHub';
	if (source === 'papers' || source === 'x' || source === 'press' || source === 'reddit') return item.source;
	return 'Article';
}

async function enrichItem(item: FeedItem, source: DigestSource): Promise<Story | null> {
	const id = storySlug(item.id);
	const cached = await readCache(id);
	const cacheOk =
		cached?.version === PROMPT_VERSION &&
		cached.title === item.title &&
		!isWeakDraft(cached.draft, item.title);

	const draft = cacheOk ? cached!.draft : await draftFromModel(item, source);
	if (!draft) {
		console.warn(`[enrich] skipping ${item.id} — no usable briefing`);
		return null;
	}

	await writeCache({
		id,
		title: item.title,
		version: PROMPT_VERSION,
		draft,
	});

	return {
		id,
		source,
		badge: badgeFor(source, item),
		title: item.title,
		lede: draft.lede,
		whyRead: draft.whyRead,
		paragraphs: draft.paragraphs,
		originalHref: item.href,
		image: null,
		stats: statsFromMeta(item.meta),
		meta: `${minutesFor(draft.paragraphs)} min read`,
		sourceLabel: item.source,
	};
}

type Sourced = { item: FeedItem; source: DigestSource };

function take(pool: FeedItem[], source: DigestSource, n: number, into: Sourced[]) {
	for (const item of pool) {
		if (into.length >= 10) return;
		if (into.some((row) => row.item.id === item.id)) continue;
		if (n <= 0) return;
		into.push({ item, source });
		n -= 1;
	}
}

export async function runEnrichment(): Promise<StoryCatalog> {
	console.log(`[enrich] text=${TEXT_MODEL} version=${PROMPT_VERSION} groq=${hasTextKey() ? 'yes' : 'no'}`);

	if (!hasTextKey()) {
		console.warn('[enrich] GROQ_API_KEY missing — writing empty catalog');
		const empty: StoryCatalog = {
			generatedAt: new Date().toISOString(),
			digest: [],
			hn: [],
			x: [],
			github: [],
			papers: [],
			press: [],
			reddit: [],
		};
		await mkdir(path.dirname(CATALOG_PATH), { recursive: true });
		await writeFile(CATALOG_PATH, JSON.stringify(empty, null, 2));
		return empty;
	}

	const [hn, github, papers, x, press, reddit] = await Promise.all([
		fetchHackerNews(10),
		fetchHottestGithubToday(6),
		fetchPapers(10),
		fetchXTimeline(10),
		fetchPressNews(8),
		fetchRedditTech(6),
	]);

	// Digest mix: HN + press + X + Reddit (github/papers stay on their section pages).
	const digestPicks: Sourced[] = [];
	take(hn, 'hn', 3, digestPicks);
	take(press, 'press', 3, digestPicks);
	take(x, 'x', 2, digestPicks);
	take(reddit, 'reddit', 2, digestPicks);
	take(hn, 'hn', 10 - digestPicks.length, digestPicks);
	take(press, 'press', 10 - digestPicks.length, digestPicks);

	const jobs: Sourced[] = [
		...digestPicks,
		...hn.map((item) => ({ item, source: 'hn' as const })),
		...x.map((item) => ({ item, source: 'x' as const })),
		...github.map((item) => ({ item, source: 'github' as const })),
		...papers.map((item) => ({ item, source: 'papers' as const })),
	];

	const unique = new Map<string, Sourced>();
	for (const job of jobs) unique.set(storySlug(job.item.id), job);

	const enriched = (
		await mapPool([...unique.values()], TEXT_CONCURRENCY, (job) => enrichItem(job.item, job.source))
	).filter((row): row is Story => Boolean(row));

	const byId = new Map(enriched.map((story) => [story.id, story]));

	const pick = (items: FeedItem[]) =>
		items.map((item) => byId.get(storySlug(item.id))).filter((row): row is Story => Boolean(row));

	const catalog: StoryCatalog = {
		generatedAt: new Date().toISOString(),
		digest: digestPicks.map((row) => byId.get(storySlug(row.item.id))).filter((row): row is Story => Boolean(row)),
		hn: pick(hn),
		x: pick(x),
		github: pick(github),
		papers: pick(papers),
		press: pick(press),
		reddit: pick(reddit),
	};

	await mkdir(path.dirname(CATALOG_PATH), { recursive: true });
	await writeFile(CATALOG_PATH, JSON.stringify(catalog, null, 2));
	console.log(
		`[enrich] wrote ${enriched.length} stories (digest ${catalog.digest.length}; press ${press.length} reddit ${reddit.length})`,
	);
	return catalog;
}

export function loadDotenv() {
	for (const file of ['.env', '.env.local']) {
		const full = path.join(process.cwd(), file);
		if (!existsSync(full)) continue;
		for (const line of readFileSync(full, 'utf8').split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eq = trimmed.indexOf('=');
			if (eq < 0) continue;
			const key = trimmed.slice(0, eq).trim();
			const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
			if (!process.env[key]) process.env[key] = value;
		}
	}
}
