import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DigestSource } from '../data/digest';
import { CATALOG_PATH, storySlug, type Story, type StoryCatalog } from './catalog';
import { TEXT_MODEL, chatCompletion, hasTextKey } from './ai';
import { headlineFromPost, isCompleteTitle, readerProse, toPlainText, xCardBlurb } from './plain';
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
const PROMPT_VERSION = 'v7-headline';
const PAPER_PROMPT_VERSION = 'v8-paper';

const CACHE_DIR = path.join(process.cwd(), '.cache/stories');
const TEXT_CONCURRENCY = 1;

const SHARED_RULES = `You write for Prodigy — a technical digest for young engineers, builders, and researchers.

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
- No URLs, @handles, or em dashes. Use periods and commas.
- Plain prose only inside JSON strings. No markdown, bullets, headings, numbered lists, or HTML.

Structure:
- "headline": a finished title, 8–16 words. It must read complete. Do not end on like, for, and, of, to, with, from, or the.
- paragraphs: at least 4 proper paragraphs for a 3–4 minute read (each several sentences). X may be 3.
- "takeaway": the one concrete thing to remember, written like the last line of a sharp note. Name the mechanism or number. Not a nudge to "check the original".
- "lede" is the card blurb (concrete stakes).
- "whyRead" is one sharp factual subhead under the title.

Return ONLY valid JSON (no markdown fences):
{
  "headline": "finished title",
  "lede": "card blurb",
  "whyRead": "one sentence subhead",
  "paragraphs": ["para1", "para2", "para3", "para4"],
  "takeaway": "concrete takeaway"
}`;

const DESK_BRIEF: Record<DigestSource, string> = {
	hn: `Desk: Hacker News.
Full 3–4 minute author note (≥4 meaty paragraphs, ~450–650 words).
Lead with the tech or claim. Fold in the shape of the discussion (camps, caveats) without saying "the thread".
Card lede: 40–65 words.`,
	x: `Desk: X.
Write a finished headline that stands alone (8–14 words). Do not chop the tweet. No links, no @handles, no em dashes.
Then 3 short paragraphs (~180–260 words) on what was actually claimed or shipped, with the numbers that matter.
Takeaway: one concrete line a reader should remember, in the same voice. Not "posted by", not "check the thread".
Card lede: 28–45 words, no URL.`,
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
You have the title and the abstract, and nothing else. Write a short technical briefing a researcher would trust. Ignore the 3–4 minute / four-paragraph target for this desk.

Exactly three paragraphs, in this order:
1. Objective. The problem and what the authors set out to do. Name the setting (task, data, constraint) when the abstract does.
2. Approach. The method in brief: what they introduce or change, in concrete terms.
3. Result. What the paper shows or claims. Use only comparisons, datasets, and numbers that appear in the abstract. If the abstract states no number, do not invent one.

"whyRead": one sentence stating the objective.
"lede": two complete sentences for the card, objective then result. About 40–70 words.
"takeaway": one sentence stating what the paper shows. Not a repeat of paragraph 1.

Accuracy rules:
- If the abstract does not say it, leave it out. Do not infer benchmarks, ablations, or limitations.
- Do not quote the abstract. Rewrite it.
- Do not repeat a sentence across paragraphs.
- Every sentence must finish. Never end on an ellipsis or a chopped clause.
- No venue name-dropping, no "this paper explores", no "the authors propose a novel".`,
	articles: `Desk: article.
Argument + mechanism + stakes. ≥4 paragraphs. Card lede: 40–65 words.`,
};

type Draft = {
	headline: string;
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
	/A closer look at|on the wire|live signal is thin|model was unavailable|This (post|tweet|thread|story|article|PR)|sounds like|reads as|delve|game-changer|in today's|source of truth|it's important to note|Here is a summary|Privacy advocates are sounding|The broader implication|helps engineers (gauge|understand)|Understanding the .+ helps|What we can verify|Why it showed up here|ranking and relevance filters|listing description is thin|Skip the hype layer|desk fallback|Posted by @|claim stands or falls|If it touches your stack|Verify the concrete claim|check the original|open the post before/i;

const MARKUP = /<!--|<\/[a-z][^>]*>|<[a-z][^>]{0,40}>/i;

function cleanProse(text: string) {
	return readerProse(
		toPlainText(text)
			.replace(/```[\s\S]*?```/g, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
	);
}

function looksDirty(text: string) {
	if (SLOP.test(text)) return true;
	// Real leftover HTML only — ignore bare < comparisons in math/prose.
	return MARKUP.test(text);
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
	if (source === 'x' || source === 'papers') return 3;
	return 4;
}

function minWords(source: DigestSource) {
	if (source === 'x' || source === 'papers') return 140;
	return 280;
}

function cacheVersion(source: DigestSource) {
	return source === 'papers' ? PAPER_PROMPT_VERSION : PROMPT_VERSION;
}

function paperDraftBroken(draft: Draft) {
	const blob = [draft.lede, draft.whyRead, draft.takeaway, ...draft.paragraphs].join('\n');
	if (/…|\.{3}/.test(blob)) return true;
	const seen = new Set<string>();
	for (const paragraph of draft.paragraphs) {
		for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
			const key = sentence.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 72);
			if (key.length < 36) continue;
			if (seen.has(key)) return true;
			seen.add(key);
		}
	}
	return false;
}

function isWeakDraft(draft: Draft | null | undefined, title: string, source: DigestSource) {
	if (!draft?.lede || !draft.takeaway) return true;
	if (draft.paragraphs.length < minParagraphs(source)) return true;
	const blob = [draft.lede, draft.whyRead, draft.takeaway, ...draft.paragraphs].join('\n');
	if (looksDirty(blob)) return true;
	if (draft.lede.includes(title) && draft.lede.length < title.length + 40) return true;
	const words = [...draft.paragraphs, draft.takeaway].join(' ').split(/\s+/).filter(Boolean).length;
	if (words < minWords(source)) return true;
	if (source === 'papers' && paperDraftBroken(draft)) return true;
	return false;
}

function isUsableDraft(draft: Draft | null | undefined, title: string, source?: DigestSource) {
	if (!draft?.lede || draft.paragraphs.length < 2 || !draft.takeaway) return false;
	const blob = [draft.lede, draft.whyRead, draft.takeaway, ...draft.paragraphs].join('\n');
	if (looksDirty(blob)) return false;
	if (
		source !== 'x' &&
		draft.lede.includes(title) &&
		draft.lede.length < title.length + 40
	) {
		return false;
	}
	if (source === 'x' && draft.headline && !isCompleteTitle(draft.headline)) return false;
	if (source === 'papers' && paperDraftBroken(draft)) return false;
	const minLen = source === 'x' ? 40 : 60;
	if (draft.paragraphs.some((paragraph) => paragraph.length < minLen)) return false;
	return true;
}

/** When the model blanks on a paper, keep complete abstract sentences. Never repeat or chop them. */
function abstractDraft(item: FeedItem): Draft | null {
	const note = cleanProse(item.summary || '')
		.replace(/…/g, ' ')
		.replace(/\.{3,}/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const title = cleanProse(item.title);
	const sentences = note
		.split(/(?<=[.!?])\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 40 && /[.!?]$/.test(part));
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const sentence of sentences) {
		const key = sentence.toLowerCase().slice(0, 72);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(sentence);
	}
	if (unique.length < 2) return null;

	const third = Math.max(1, Math.ceil(unique.length / 3));
	const paragraphs = [unique.slice(0, third), unique.slice(third, third * 2), unique.slice(third * 2)]
		.filter((group) => group.length > 0)
		.map((group) => group.join(' '));
	if (paragraphs.length < 2) return null;

	const result =
		[...unique]
			.reverse()
			.find((sentence) =>
				/\d|outperform|improv|reduc|achiev|show|demonstrat|prove|better|accurate|state of the art/i.test(sentence),
			) || unique[unique.length - 1];

	return {
		headline: title,
		lede: unique.slice(0, 2).join(' '),
		whyRead: unique[0],
		paragraphs,
		takeaway: result,
	};
}

/** X fallback: the post itself, cleaned. No attribution filler. */
function tweetDraft(item: FeedItem): Draft | null {
	const note = cleanProse(item.summary || item.title);
	if (note.length < 40) return null;

	const sentences = note
		.split(/(?<=[.!?])\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 30 && !/^media$/i.test(part));
	if (!sentences.length) return null;

	const chunks: string[] = [];
	let bucket = '';
	for (const sentence of sentences) {
		bucket = bucket ? `${bucket} ${sentence}` : sentence;
		if (bucket.length >= 140) {
			chunks.push(bucket);
			bucket = '';
		}
	}
	if (bucket) chunks.push(bucket);
	const paragraphs = chunks.slice(0, 4);
	while (paragraphs.length < 3 && sentences.length > paragraphs.length) {
		paragraphs.push(sentences[paragraphs.length]);
	}
	if (paragraphs.length < 2) return null;

	const concrete = [...sentences].sort((a, b) => Number(/\d/.test(b)) - Number(/\d/.test(a)))[0];
	const headline = headlineFromPost(note);

	return {
		headline,
		lede: paragraphs[0].slice(0, 280),
		whyRead: cleanProse(item.meta || '').replace(/@/g, '') || 'From X',
		paragraphs,
		takeaway: concrete,
	};
}

function deskDraft(item: FeedItem, source: DigestSource): Draft | null {
	if (source === 'papers') return abstractDraft(item);
	if (source === 'x') return tweetDraft(item);
	return null;
}

let textBudgetExhausted = false;

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
		const headline = cleanProse(String(parsed.headline ?? ''));
		if (!lede || paragraphs.length < 2 || !takeaway) return null;
		return { headline, lede, whyRead, paragraphs, takeaway };
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
		source === 'papers'
			? 'Three paragraphs only: objective, approach, result. Stay inside the abstract.'
			: `Minimum ${minParagraphs(source)} proper paragraphs. End with a concrete takeaway. Author voice — not a summary bot.`,
	]
		.filter(Boolean)
		.join('\n\n');
}

async function draftFromModel(item: FeedItem, source: DigestSource): Promise<Draft | null> {
	if (textBudgetExhausted) return null;

	const maxTokens = source === 'x' ? 1200 : source === 'papers' ? 1400 : 2400;
	const temperature = source === 'papers' ? 0.3 : 0.55;
	let salvage: Draft | null = null;
	try {
		const raw = await chatCompletion(
			[
				{ role: 'system', content: SHARED_RULES },
				{ role: 'user', content: buildUserPrompt(item, source) },
			],
			{ maxTokens, temperature, json: true },
		);
		const parsed = extractJson(raw);
		if (parsed && isUsableDraft(parsed, item.title, source)) salvage = parsed;
		if (parsed && !isWeakDraft(parsed, item.title, source)) return parsed;

		console.warn(`[enrich] weak draft for ${item.id}; retrying once`);
		const retryNote =
			source === 'papers'
				? 'Previous draft was inaccurate, repetitive, or padded. Rewrite from the abstract only. Three paragraphs: objective, method, then what the paper shows. No ellipsis. No invented numbers or datasets.'
				: `Previous draft was too short, too meta, or AI-slop. Rewrite as a dense 3–4 minute technical note with ≥${minParagraphs(source)} real paragraphs and a sharp takeaway. Lead with the mechanism.`;
		const retry = await chatCompletion(
			[
				{ role: 'system', content: SHARED_RULES },
				{
					role: 'user',
					content: `${buildUserPrompt(item, source)}\n\n${retryNote}`,
				},
			],
			{ maxTokens, temperature: source === 'papers' ? 0.2 : 0.65, json: true },
		);
		const second = extractJson(retry);
		if (second && !isWeakDraft(second, item.title, source)) return second;
		if (second && isUsableDraft(second, item.title, source)) return second;
		if (salvage) return salvage;
		return null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[enrich] text failed for ${item.id}:`, message);
		if (/429|tokens per day|TPD|rate limit/i.test(message)) {
			textBudgetExhausted = true;
			console.warn('[enrich] Groq budget exhausted — using desk drafts for remaining items');
		}
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

function resolveStoryTitle(item: FeedItem, source?: DigestSource) {
	const raw = toPlainText(item.title);
	const note = toPlainText(item.summary || '');
	const truncated = /…|\.\.\.$/.test(raw);
	const base =
		truncated && note.length > raw.replace(/[.…]+$/u, '').trim().length + 12
			? note
			: raw.replace(/[.…]+$/u, '').trim() || note || 'Untitled';
	if (source === 'x') return headlineFromPost(`${item.summary || ''} ${item.title}`);
	return base;
}

async function enrichItem(item: FeedItem, source: DigestSource): Promise<Story | null> {
	const id = storySlug(item.id);
	const title = resolveStoryTitle(item, source);
	const cached = await readCache(id);
	const cacheOk =
		cached?.version === cacheVersion(source) && isUsableDraft(cached.draft, cached.title, source);

	let draft = cacheOk ? cached!.draft : await draftFromModel({ ...item, title }, source);
	if (draft) {
		const headline =
			source === 'x'
				? isCompleteTitle(draft.headline)
					? cleanProse(draft.headline)
					: headlineFromPost(item.summary || item.title)
				: cleanProse(draft.headline || title);
		draft = {
			headline,
			lede: cleanProse(draft.lede),
			whyRead: cleanProse(draft.whyRead),
			paragraphs: draft.paragraphs.map(cleanProse).filter((paragraph) => paragraph.length > 40),
			takeaway: cleanProse(draft.takeaway),
		};
	}
	if (!draft || !isUsableDraft(draft, title, source)) {
		const fallback = deskDraft({ ...item, title }, source);
		if (fallback && isUsableDraft(fallback, title, source)) {
			console.warn(`[enrich] desk draft for ${item.id} (${source})`);
			draft = fallback;
		}
	}
	if (!draft || !isUsableDraft(draft, title, source)) {
		console.warn(`[enrich] skipping ${item.id} — briefing was empty or still had markup`);
		return null;
	}

	const publishedTitle = source === 'x' && draft.headline ? draft.headline : title;

	await writeCache({
		id,
		title: publishedTitle,
		version: cacheVersion(source),
		draft,
	});

	return {
		id,
		source,
		badge: badgeFor(source, item),
		title: publishedTitle,
		lede: draft.lede,
		whyRead: draft.whyRead,
		paragraphs: draft.paragraphs,
		takeaway: draft.takeaway,
		blurb: source === 'x' ? xCardBlurb(publishedTitle, item.summary || item.title) : undefined,
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
		fetchPapers(24),
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
		...x.map((item) => ({ item, source: 'x' as const })),
		...hn.map((item) => ({ item, source: 'hn' as const })),
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
		`[enrich] wrote ${enriched.length} stories (digest ${catalog.digest.length}; x ${catalog.x.length}; github ${catalog.github.length}; papers ${catalog.papers.length}; press ${catalog.press.length}; reddit ${catalog.reddit.length})`,
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
