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
	fetchXTimeline,
	type FeedItem,
} from './feeds';

/** Bump to invalidate fallback/slop caches. */
const PROMPT_VERSION = 'v3-text';

const CACHE_DIR = path.join(process.cwd(), '.cache/stories');
const TEXT_CONCURRENCY = 1;

const SHARED_RULES = `You are a sharp human editor for AweSam — a technical digest for systems, AI, and programming people.

Write like a curious senior engineer at a laptop late at night: specific, opinionated, alive. Not like a chatbot.

Hard rules:
- Never copy, quote, or closely paraphrase the source. Transform it.
- Do not invent numbers, benchmarks, quotes, authors, or results missing from the notes.
- If notes are thin, be honest about uncertainty — still make the briefing vivid and useful.
- Ban AI slop: no "A closer look at", "delve", "landscape", "in today's world", "it's important to note", "robust solution", "game-changer", "leverage", "unlock", "empower".
- Ban the phrases "on the wire", "live signal is thin", "model was unavailable", "treat the original as the source of truth".
- Prefer concrete nouns, verbs, and stakes over adjectives.
- Length: a 2–3 minute read (~320–480 words across 3–5 short paragraphs).

Return ONLY valid JSON (no markdown fences):
{
  "lede": "50-80 words. Hook a senior engineer. Specific stakes.",
  "whyRead": "one crisp human sentence",
  "paragraphs": ["paragraph 1", "paragraph 2", "paragraph 3", "..."]
}`;

const DESK_BRIEF: Record<DigestSource, string> = {
	hn: `Desk: Hacker News.
Angle: why this is climbing, the systems/privacy/AI implication, and what to pressure-test in the thread.
Sound like someone who reads HN for craft, not karma.`,
	x: `Desk: X / lab signal.
Angle: what actually shipped or was claimed. Expand carefully — do not invent a paper from a tweet.
Keep energy high; keep claims tight.`,
	github: `Desk: rising GitHub repo.
Angle: what it does, who it is for, why it is getting stars now. Make a builder want to clone it — or know why to skip it.`,
	papers: `Desk: research paper.
Angle: problem → approach → why a practitioner should care. Stay faithful to the abstract. Make the idea feel urgent, not academic-flat.`,
	articles: `Desk: article.
Angle: the argument and the stakes for an engineering reader.`,
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
	return Math.max(2, Math.min(3, Math.round(words / 200) || 2));
}

const SLOP =
	/A closer look at|on the wire|live signal is thin|model was unavailable|systems-minded reader|source of truth and use this note|delve|game-changer|in today's/i;

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
		item.summary ? `Source notes:\n${item.summary}` : 'Source notes: title/meta only — do not invent an abstract.',
		item.meta ? `Signals: ${item.meta}` : '',
		`URL (orientation only): ${item.href}`,
		DESK_BRIEF[source],
		`Write a briefing that could only fit this title. Make it exciting and human. No generic filler.`,
	]
		.filter(Boolean)
		.join('\n\n');
}

async function draftFromModel(item: FeedItem, source: DigestSource): Promise<Draft | null> {
	try {
		const raw = await chatCompletion(
			[
				{ role: 'system', content: SHARED_RULES },
				{ role: 'user', content: buildUserPrompt(item, source) },
			],
			{ maxTokens: 1800, temperature: 0.55, json: true },
		);
		const parsed = extractJson(raw);
		if (!parsed || isWeakDraft(parsed, item.title)) {
			console.warn(`[enrich] weak draft for ${item.id}; retrying once`);
			const retry = await chatCompletion(
				[
					{ role: 'system', content: SHARED_RULES },
					{
						role: 'user',
						content: `${buildUserPrompt(item, source)}\n\nPrevious attempt was too generic. Rewrite with sharper specifics and zero filler.`,
					},
				],
				{ maxTokens: 1800, temperature: 0.65, json: true },
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

	const badge =
		source === 'papers' || source === 'x'
			? item.source
			: source === 'hn'
				? 'HN · Best'
				: source === 'github'
					? 'GitHub'
					: 'Article';

	return {
		id,
		source,
		badge,
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
		};
		await mkdir(path.dirname(CATALOG_PATH), { recursive: true });
		await writeFile(CATALOG_PATH, JSON.stringify(empty, null, 2));
		return empty;
	}

	const [hn, github, papers, x] = await Promise.all([
		fetchHackerNews(10),
		fetchHottestGithubToday(6),
		fetchPapers(10),
		fetchXTimeline(10),
	]);

	const jobs: Sourced[] = [
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

	const digestPicks: Sourced[] = [];
	take(hn, 'hn', 4, digestPicks);
	take(github, 'github', 2, digestPicks);
	take(papers, 'papers', 2, digestPicks);
	take(x, 'x', 2, digestPicks);
	take(hn, 'hn', 10 - digestPicks.length, digestPicks);

	const catalog: StoryCatalog = {
		generatedAt: new Date().toISOString(),
		digest: digestPicks.map((row) => byId.get(storySlug(row.item.id))).filter((row): row is Story => Boolean(row)),
		hn: pick(hn),
		x: pick(x),
		github: pick(github),
		papers: pick(papers),
	};

	await mkdir(path.dirname(CATALOG_PATH), { recursive: true });
	await writeFile(CATALOG_PATH, JSON.stringify(catalog, null, 2));
	console.log(`[enrich] wrote ${enriched.length} stories (digest ${catalog.digest.length})`);
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
