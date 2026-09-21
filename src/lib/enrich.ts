import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DigestSource } from '../data/digest';
import { CATALOG_PATH, storySlug, type Story, type StoryCatalog } from './catalog';
import { TEXT_MODEL, chatCompletion, hasTextKey } from './ai';
import { toPlainText } from './plain';
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
const PROMPT_VERSION = 'v6-plain';

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
- Plain prose only inside JSON strings — no markdown, bullets, headings, numbered lists, HTML tags, comments, or entities (`&quot;`, `&#39;`, `&amp;`).

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
	/A closer look at|on the wire|live signal is thin|model was unavailable|This (post|tweet|thread|story|article|PR)|sounds like|reads as|delve|game-changer|in today's|source of truth|it's important to note|Here is a summary|Privacy advocates are sounding|The broader implication|helps engineers (gauge|understand)|Understanding the .+ helps|What we can verify|Why it showed up here|ranking and relevance filters|listing description is thin|Skip the hype layer|desk fallback/i;

const MARKUP = /<!--|<\/?[a-z][^>]*>|&(?:quot|amp|lt|gt|nbsp|#\d+|#x[0-9a-f]+);|&39/i;

function cleanProse(text: string) {
	return toPlainText(text)
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function looksDirty(text: string) {
	return MARKUP.test(text) || SLOP.test(text);
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

function minWords(source: DigestSource) {
	return source === 'x' ? 140 : 280;
}

function isWeakDraft(draft: Draft | null | undefined, title: string, source: DigestSource) {
	if (!draft?.lede || !draft.takeaway) return true;
	if (draft.paragraphs.length < minParagraphs(source)) return true;
	const blob = [draft.lede, draft.whyRead, draft.takeaway, ...draft.paragraphs].join('\n');
	if (looksDirty(blob)) return true;
	if (draft.lede.includes(title) && draft.lede.length < title.length + 40) return true;
	const words = [...draft.paragraphs, draft.takeaway].join(' ').split(/\s+/).filter(Boolean).length;
	if (words < minWords(source)) return true;
	return false;
}

function isUsableDraft(draft: Draft | null | undefined, title: string) {
	if (!draft?.lede || draft.paragraphs.length < 2 || !draft.takeaway) return false;
	const blob = [draft.lede, draft.whyRead, draft.takeaway, ...draft.paragraphs].join('\n');
	if (looksDirty(blob)) return false;
	if (draft.lede.includes(title) && draft.lede.length < title.length + 40) return false;
	if (draft.paragraphs.some((paragraph) => paragraph.length < 80)) return false;
	return true;
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
			? `Source notes (plain text already — stay faithful, do not echo markup):\n${toPlainText(item.summary)}`
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
	let salvage: Draft | null = null;
	try {
		const raw = await chatCompletion(
			[
				{ role: 'system', content: SHARED_RULES },
				{ role: 'user', content: buildUserPrompt(item, source) },
			],
			{ maxTokens, temperature: 0.55, json: true },
		);
		const parsed = extractJson(raw);
		if (parsed && isUsableDraft(parsed, item.title)) salvage = parsed;
		if (parsed && !isWeakDraft(parsed, item.title, source)) return parsed;

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
		if (second && !isWeakDraft(second, item.title, source)) return second;
		if (second && isUsableDraft(second, item.title)) return second;
		if (salvage) return salvage;
		return null;
	} catch (error) {
		console.warn(`[enrich] text failed for ${item.id}:`, error instanceof Error ? error.message : error);
		return salvage;
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
		isUsableDraft(cached.draft, item.title);

	let draft = cacheOk ? cached!.draft : await draftFromModel(item, source);
	if (draft) {
		draft = {
			lede: cleanProse(draft.lede),
			whyRead: cleanProse(draft.whyRead),
			paragraphs: draft.paragraphs.map(cleanProse).filter((paragraph) => paragraph.length > 40),
			takeaway: cleanProse(draft.takeaway),
		};
	}
	if (!draft || !isUsableDraft(draft, item.title)) {
		console.warn(`[enrich] skipping ${item.id} — briefing was empty or still had markup`);
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
		title: toPlainText(item.title),
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

function assembleDigest(
	picks: Sourced[],
	byId: Map<string, Story>,
	backfill: { items: FeedItem[]; source: DigestSource }[],
): Story[] {
	const out: Story[] = [];
	const seen = new Set<string>();

	const push = (story: Story | undefined) => {
		if (!story || seen.has(story.id) || out.length >= 10) return;
		seen.add(story.id);
		out.push(story);
	};

	for (const row of picks) push(byId.get(storySlug(row.item.id)));
	for (const pool of backfill) {
		for (const item of pool.items) push(byId.get(storySlug(item.id)));
	}
	return out;
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
		fetchHackerNews(14),
		fetchHottestGithubToday(10),
		fetchPapers(12),
		fetchXTimeline(10),
		fetchPressNews(10),
		fetchRedditTech(8),
	]);

	// Digest mix: HN + press + X + Reddit (github/papers stay on their section pages).
	const digestPicks: Sourced[] = [];
	take(hn, 'hn', 3, digestPicks);
	take(press, 'press', 3, digestPicks);
	take(x, 'x', 2, digestPicks);
	take(reddit, 'reddit', 2, digestPicks);
	take(hn, 'hn', 10 - digestPicks.length, digestPicks);
	take(press, 'press', 10 - digestPicks.length, digestPicks);
	take(x, 'x', 10 - digestPicks.length, digestPicks);
	take(reddit, 'reddit', 10 - digestPicks.length, digestPicks);

	const jobs: Sourced[] = [
		...digestPicks,
		...hn.map((item) => ({ item, source: 'hn' as const })),
		...x.map((item) => ({ item, source: 'x' as const })),
		...press.map((item) => ({ item, source: 'press' as const })),
		...reddit.map((item) => ({ item, source: 'reddit' as const })),
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
		digest: assembleDigest(digestPicks, byId, [
			{ items: hn, source: 'hn' },
			{ items: press, source: 'press' },
			{ items: x, source: 'x' },
			{ items: reddit, source: 'reddit' },
		]),
		hn: pick(hn).slice(0, 10),
		x: pick(x).slice(0, 10),
		github: pick(github).slice(0, 10),
		papers: pick(papers).slice(0, 10),
		press: pick(press),
		reddit: pick(reddit),
	};

	await mkdir(path.dirname(CATALOG_PATH), { recursive: true });
	await writeFile(CATALOG_PATH, JSON.stringify(catalog, null, 2));
	console.log(
		`[enrich] wrote ${enriched.length} stories (digest ${catalog.digest.length}; github ${catalog.github.length}; papers ${catalog.papers.length}; press ${catalog.press.length}; reddit ${catalog.reddit.length})`,
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
