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
const PROMPT_VERSION = 'v5-author';

const CACHE_DIR = path.join(process.cwd(), '.cache/stories');
const TEXT_CONCURRENCY = 1;

const SHARED_RULES = `You write for AweSam — a technical digest for young engineers, builders, and researchers.

Read the source carefully and write a concise technical digest of it.

The output should feel like it was written by a technically experienced engineer/researcher who actually understood the material — not like an AI-generated summary.

Focus on:
- What actually happened or was built
- The important technical mechanism, architecture, or idea
- Why it matters to engineers/researchers
- The key tradeoffs, limitations, or implications
- Any numbers, benchmarks, implementation details, or concrete evidence that matter

Skip generic introductions, obvious context, marketing language, and filler.

Write it as a 3–4 minute technical read: dense, clear, and interesting, but concise. Explain the important parts rather than merely listing them.

Use precise technical language where appropriate. Assume the reader is technically literate, so don't over-explain basic concepts.

The writing should have a confident editorial voice, with natural variation in sentence length and structure. It should read like a sharp technical note from an engineer — not like "Here is a summary of the article."

Informal is fine. Sound like someone who ships code.

Hard bans:
- Never meta-comment on the source ("This post…", "This tweet…", "This PR…", "This HN thread…", "sounds like…", "reads as…", "Here is a summary…").
- No AI slop: delve, landscape, robust, leverage, unlock, empower, game-changer, "in today's world", "it's important to note", "A closer look at", "on the wire", "source of truth", "Privacy advocates are sounding the alarm", "The broader implication is", "helps engineers gauge/understand".
- Do not invent numbers, quotes, authors, benchmarks, or conclusions missing from the source notes.
- Never copy the source verbatim. Rewrite.
- Plain prose only inside JSON strings — no markdown, bullets, headings, or numbered lists.

Structure:
- paragraphs: at least 4 proper paragraphs for a 3–4 minute read (each paragraph several sentences; not one-liners).
- End the piece by putting the single most important takeaway in "takeaway" — what a technically informed reader should remember.
- "lede" is the card blurb (concrete stakes, not a teaser about "why you should read").
- "whyRead" is one sharp factual subhead under the title — not a pitch.

Return ONLY valid JSON (no markdown fences):
{
  "lede": "card blurb",
  "whyRead": "one sentence subhead",
  "paragraphs": ["para1", "para2", "para3", "para4"],
  "takeaway": "single most important takeaway"
}`;

const DESK_BRIEF: Record<DigestSource, string> = {
	hn: `Desk: Hacker News.
Full 3–4 minute author note (≥4 meaty paragraphs, ~450–650 words).
Lead with the tech or claim. Fold in the shape of the discussion (camps, caveats) without saying "the thread".
Card lede: 40–65 words.`,
	x: `Desk: X.
Still author voice, but tighter: 3–4 short paragraphs (~220–320 words). Simple and to the point.
Say what was claimed or shipped. No fluff.
Card lede: 28–45 words.`,
	press: `Desk: tech press (WIRED / TechCrunch / The Verge).
Full 3–4 minute read (≥4 paragraphs). Lead with product/company/tech claim. Skeptical and concrete.
Card lede: 40–65 words.`,
	reddit: `Desk: Reddit.
Full 3–4 minute read (≥4 paragraphs) on the idea people are chewing on. Technical, a bit informal. Skip meme voice.
Card lede: 35–55 words.`,
	github: `Desk: rising GitHub repo.
What it does, architecture/mechanism, who it's for, why stars are moving. ≥4 paragraphs.
Card lede: 35–55 words.`,
	papers: `Desk: research paper.
Problem → approach → evidence → why a practitioner should care. Faithful to the abstract. ≥4 paragraphs.
Card lede: 40–65 words.`,
	articles: `Desk: article.
Argument + mechanism + stakes. ≥4 paragraphs. Card lede: 40–65 words.`,
};

type Draft = {
	lede: string;
	whyRead: string;
	paragraphs: string[];
	takeaway: string;
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

function minutesFor(paragraphs: string[], takeaway: string) {
	const words = [...paragraphs, takeaway].join(' ').split(/\s+/).filter(Boolean).length;
	return Math.max(3, Math.min(4, Math.round(words / 160) || 3));
}

const SLOP =
	/A closer look at|on the wire|live signal is thin|model was unavailable|This (post|tweet|thread|story|article|PR)|sounds like|reads as|delve|game-changer|in today's|source of truth|it's important to note|Here is a summary|Privacy advocates are sounding|The broader implication|helps engineers (gauge|understand)|Understanding the .+ helps/i;

function cleanProse(text: string) {
	return text
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/[*_`#]+/g, '')
		.replace(/^\s*[-•]\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeParagraphs(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const entry of raw) {
		const chunks = String(entry)
			.split(/\n{2,}/)
			.map(cleanProse)
			.filter((p) => p.length > 40);
		out.push(...chunks);
	}
	return out;
}

function minParagraphs(source: DigestSource) {
	return source === 'x' ? 3 : 4;
}

function isWeakDraft(draft: Draft | null | undefined, title: string, source: DigestSource) {
	if (!draft?.lede || !draft.takeaway) return true;
	if (draft.paragraphs.length < minParagraphs(source)) return true;
	const blob = [draft.lede, draft.whyRead, draft.takeaway, ...draft.paragraphs].join('\n');
	if (SLOP.test(blob)) return true;
	if (draft.lede.includes(title) && draft.lede.length < title.length + 40) return true;
	const words = [...draft.paragraphs, draft.takeaway].join(' ').split(/\s+/).filter(Boolean).length;
	if (source !== 'x' && words < 380) return true;
	if (source === 'x' && words < 180) return true;
	return false;
}

function extractJson(text: string): Draft | null {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Draft>;
		const paragraphs = normalizeParagraphs(parsed.paragraphs);
		const lede = cleanProse(String(parsed.lede ?? ''));
		const whyRead = cleanProse(String(parsed.whyRead ?? ''));
		const takeaway = cleanProse(String(parsed.takeaway ?? ''));
		if (!lede || paragraphs.length < 2 || !takeaway) return null;
		return { lede, whyRead, paragraphs, takeaway };
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
		item.summary
			? `Source notes (read carefully; stay faithful):\n${item.summary}`
			: 'Source notes: title/meta only — do not invent details, numbers, or conclusions.',
		item.meta ? `Signals: ${item.meta}` : '',
		`URL (orientation only): ${item.href}`,
		DESK_BRIEF[source],
		`Minimum ${minParagraphs(source)} proper paragraphs. End with a concrete takeaway. Author voice — not a summary bot.`,
	]
		.filter(Boolean)
		.join('\n\n');
}

async function draftFromModel(item: FeedItem, source: DigestSource): Promise<Draft | null> {
	const maxTokens = source === 'x' ? 1200 : 2400;
	try {
		const raw = await chatCompletion(
			[
				{ role: 'system', content: SHARED_RULES },
				{ role: 'user', content: buildUserPrompt(item, source) },
			],
			{ maxTokens, temperature: 0.55, json: true },
		);
		const parsed = extractJson(raw);
		if (!parsed || isWeakDraft(parsed, item.title, source)) {
			console.warn(`[enrich] weak draft for ${item.id}; retrying once`);
			const retry = await chatCompletion(
				[
					{ role: 'system', content: SHARED_RULES },
					{
						role: 'user',
						content: `${buildUserPrompt(item, source)}\n\nPrevious draft was too short, too meta, or AI-slop. Rewrite as a dense 3–4 minute technical note with ≥${minParagraphs(source)} real paragraphs and a sharp takeaway. Lead with the mechanism.`,
					},
				],
				{ maxTokens, temperature: 0.65, json: true },
			);
			const second = extractJson(retry);
			if (!second || isWeakDraft(second, item.title, source)) return null;
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
		!isWeakDraft(cached.draft, item.title, source);

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
		takeaway: draft.takeaway,
		originalHref: item.href,
		image: null,
		stats: statsFromMeta(item.meta),
		meta: `${minutesFor(draft.paragraphs, draft.takeaway)} min read`,
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
