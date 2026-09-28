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
const PROMPT_VERSION = 'v10-natural';
const PAPER_PROMPT_VERSION = 'v10-paper';

const CACHE_DIR = path.join(process.cwd(), '.cache/stories');
const TEXT_CONCURRENCY = 1;

const SHARED_RULES = `You write short technical notes for Prodigy, a daily digest read by young engineers and researchers.

Write like a senior engineer telling a friend what they just read: plain words, specific facts, no performance. It is a 3 to 4 minute read, 450 to 650 words, and every paragraph should earn its place.

How a good note reads:
- Paragraph 1 states what happened and the most striking fact or number, in the first sentence. No scene-setting.
- Paragraphs 2 and 3 explain how it works or why it happened: the mechanism, the design choices, the numbers. Use only what the source says, and go deep on it rather than wide.
- Paragraph 4 says what changes for someone building software or doing research.
- An optional paragraph 5 covers a real limit, cost, or open question, only if the source gives one.
- Each paragraph is 3 to 5 sentences. Mix short and long sentences.
- Prefer concrete nouns and verbs over abstractions. "Cuts output tokens by 40 percent" beats "improves efficiency significantly".
- If the source is thin, explain the concepts it names in more depth. Do not fill space with opinions or wrap-ups.

Accuracy comes first:
- Use only facts in the source notes. If the source does not explain the mechanism, do not describe one. Say less instead.
- Never invent numbers, pipelines, internal tools, quotes, or motives.

Do not write like this:
- Moralizing or big-picture wrap-ups: "underscores", "highlights the", "forces a reckoning", "raises questions", "serves as a reminder", "in an era of".
- Addressing groups: "For engineers and policy designers", "For developers".
- Filler words: delve, landscape, robust, leverage, unlock, empower, seamless, game-changer, crucial, pivotal, tangible, notably.
- Balanced-essay padding: "speed comes at the cost of", "on one hand", "while X, Y".
- Meta comments: "This post", "This article", "The thread", "Here is a summary".
- No URLs, @handles, em dashes, hyphen-joined word chains, markdown, bullets, or HTML.

Fields:
- "headline": a complete title, 8 to 14 words. Do not end on a preposition or article.
- "whyRead": one sentence on what the reader will learn.
- "lede": the card blurb, 1 or 2 sentences with the key fact.
- "paragraphs": 4 or 5, as described above.
- "takeaway": one plain sentence, under 25 words, stating the lesson. Not a summary of paragraph 1.

Return ONLY valid JSON (no markdown fences):
{
  "headline": "finished title",
  "lede": "card blurb",
  "whyRead": "one sentence subhead",
  "paragraphs": ["para1", "para2", "para3", "para4"],
  "takeaway": "concrete takeaway"
}`;

const DESK_BRIEF: Record<DigestSource, string> = {
	hn: `Desk: Hacker News. Lead with the technical claim or result. If the notes include discussion, fold in the sharpest objection naturally.`,
	x: `Desk: X. A short post. Say what was claimed or shipped and the number that matters. Keep it brief.`,
	press: `Desk: tech press. Lead with what the company or product actually did. Stay factual and a little skeptical. No speculation about internal systems.`,
	reddit: `Desk: Reddit. Lead with the idea or result people are discussing, in plain technical terms.`,
	github: `Desk: GitHub repo. What it does, how it works if the notes say, and who would use it.`,
	papers: `Desk: research paper. You have only the title and abstract. Paragraphs in this order:
1. The problem and what the authors set out to do.
2 and 3. The method in concrete terms, and the ideas it builds on, explained for a technical reader.
4. What the paper shows, with only the numbers and comparisons in the abstract.
5 (optional). What it would change in practice, or what the abstract leaves open.
Rewrite, do not quote. Never write "this paper explores" or "a novel approach".`,
	articles: `Desk: article. Lead with the argument, then the evidence behind it.`,
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
	/A closer look at|on the wire|live signal is thin|model was unavailable|This (post|tweet|thread|story|article|PR)|sounds like|reads as|delve|game-changer|in today's|source of truth|it's important to note|Here is a summary|Privacy advocates are sounding|The broader implication|helps engineers (gauge|understand)|Understanding the .+ helps|What we can verify|Why it showed up here|ranking and relevance filters|listing description is thin|Skip the hype layer|desk fallback|Posted by @|claim stands or falls|If it touches your stack|Verify the concrete claim|check the original|open the post before|underscores (how|the)|forces a reckoning|serves as a reminder|For (engineers|developers) and|in an era of/i;

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
	return source === 'x' ? 2 : 4;
}

function minWords(source: DigestSource) {
	return source === 'x' ? 70 : 380;
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
	if (source !== 'x' && [...draft.paragraphs, draft.takeaway].join(' ').split(/\s+/).length < 200) return false;
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
	const notes = toPlainText(item.summary || '').slice(0, 3000);
	return [
		DESK_BRIEF[source],
		`Source: ${item.source}`,
		`Title: ${item.title}`,
		notes ? `Source notes:\n${notes}` : 'Source notes: title only. Keep the note short and do not invent details.',
		item.meta ? `Signals: ${item.meta}` : '',
	]
		.filter(Boolean)
		.join('\n\n');
}

async function draftFromModel(item: FeedItem, source: DigestSource): Promise<Draft | null> {
	if (textBudgetExhausted) return null;

	const maxTokens = source === 'x' ? 600 : 1500;
	const temperature = source === 'papers' ? 0.3 : 0.6;
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
		if (salvage) return salvage;

		console.warn(`[enrich] unusable draft for ${item.id}; retrying once`);
		const retryNote =
			'The last draft broke the rules. Rewrite in plain words: 4 or 5 paragraphs, 450 to 650 words, facts from the notes only, no moralizing wrap-up.';
		const retry = await chatCompletion(
			[
				{ role: 'system', content: SHARED_RULES },
				{
					role: 'user',
					content: `${buildUserPrompt(item, source)}\n\n${retryNote}`,
				},
			],
			{ maxTokens, temperature: source === 'papers' ? 0.2 : 0.5, json: true },
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
