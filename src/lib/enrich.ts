import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DigestSource } from '../data/digest';
import { CATALOG_PATH, storySlug, type Story, type StoryCatalog } from './catalog';
import { TEXT_MODEL, chatCompletion, generateCoverPng, hasTextKey, seedFromId } from './ai';
import {
	fetchHackerNews,
	fetchHottestGithubToday,
	fetchPapers,
	fetchXTimeline,
	type FeedItem,
} from './feeds';

/** Bump to invalidate bad fallback caches from the first deploy. */
const PROMPT_VERSION = 'v2';

const CACHE_DIR = path.join(process.cwd(), '.cache/stories');
const COVER_CACHE = path.join(process.cwd(), '.cache/covers');
const PUBLIC_COVERS = path.join(process.cwd(), 'public/covers');

const TEXT_CONCURRENCY = 1;
const IMAGE_CONCURRENCY = 1;

const SHARED_RULES = `You write original briefings for AweSam, a technical digest.

Hard rules:
- Never copy, quote, or closely paraphrase the source. Rewrite as a new editorial briefing.
- Do not invent numbers, benchmarks, quotes, authors, or results absent from the source notes.
- If notes are thin, say what is known and what a careful engineer should verify — do not fabricate.
- Voice: precise, concrete, slightly literary. Second person is welcome. No hype, no "delve", no "in today's fast-paced world", no "A closer look at…".
- Return ONLY valid JSON (no markdown fences) with exactly these keys:
{
  "lede": "45-70 words for the card. Specific stakes for a systems/AI engineer.",
  "whyRead": "one crisp sentence",
  "paragraphs": ["3 to 5 short paragraphs totaling ~320-480 words"],
  "imagePrompt": "one concrete visual sentence unique to THIS story: objects, setting, mood. No text, letters, logos, UI, or watermarks.",
  "wantImage": true
}`;

const DESK_BRIEF: Record<DigestSource, string> = {
	hn: `Desk: Hacker News.
Write like a sharp HN commenter who cares about systems, privacy, AI, and infrastructure.
Focus on why the story is rising, the technical or policy implication, and what to inspect in the discussion.
Set wantImage true ONLY if the story is visually distinctive (hardware, architecture, research artifact, security incident with a clear visual metaphor). Otherwise false.`,
	x: `Desk: X / lab signal.
Treat the post as a short signal, not a paper. Expand carefully into what released, claimed, or linked — without inventing paper results.
Keep the briefing shorter if the source is a tweet (still 3 paragraphs minimum).
Set wantImage true ONLY for launches, demos, hardware, papers, or strong visual metaphors. Routine commentary → wantImage false.`,
	github: `Desk: GitHub hot repo.
Explain what the repo does, who it is for, and why it is rising now. Use description + stars as soft signals only.
Always set wantImage true — one unique cover for the tool/domain.`,
	papers: `Desk: research paper.
Explain the problem, the approach, and why a practitioner should care. Stay faithful to the abstract notes.
Always set wantImage true — one unique research illustration.`,
	articles: `Desk: article.
Summarize the argument and stakes for an engineering reader.
Set wantImage true when a clear visual metaphor exists.`,
};

type Draft = {
	lede: string;
	whyRead: string;
	paragraphs: string[];
	imagePrompt: string;
	wantImage: boolean;
};

type CacheRow = {
	id: string;
	title: string;
	version: string;
	draft: Draft;
	imageFile: string | null;
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

function isWeakDraft(draft: Draft | null | undefined, title: string) {
	if (!draft?.lede || draft.paragraphs.length < 2) return true;
	if (/^A closer look at /i.test(draft.lede)) return true;
	if (draft.lede.includes(title) && draft.lede.includes('systems-minded reader')) return true;
	if (/Quiet editorial still life about software craft/i.test(draft.imagePrompt)) return true;
	return false;
}

function fallbackDraft(item: FeedItem, source: DigestSource): Draft {
	const base = item.summary?.trim();
	const lede = (base || `${item.title} is on the wire — treat the original as the source of truth and use this note as a map of what to verify.`)
		.replace(/\s+/g, ' ')
		.slice(0, 280);
	return {
		lede,
		whyRead: `Open the original ${item.source} item after this briefing if the claim matters to your stack.`,
		paragraphs: [
			lede,
			`The live signal is thin or the model was unavailable, so this note stays conservative. Do not treat it as a substitute for the primary ${item.source} post.`,
			`Check the original link at the end for discussion, numbers, and updates before you act on it.`,
		],
		imagePrompt: uniqueFallbackVisual(item, source),
		wantImage: source === 'papers' || source === 'github',
	};
}

function uniqueFallbackVisual(item: FeedItem, source: DigestSource) {
	const motif =
		source === 'papers'
			? 'research notebook, chalk diagrams, soft lamp'
			: source === 'github'
				? 'workbench with tools and circuit boards'
				: source === 'x'
					? 'signal beacon over a night city grid'
					: 'newsroom desk with typescript pages and ink';
	return `${motif}, inspired by the idea of “${item.title.slice(0, 80)}”, editorial illustration, unique composition`;
}

function extractJson(text: string): Draft | null {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Draft> & { wantImage?: boolean };
		const paragraphs = Array.isArray(parsed.paragraphs)
			? parsed.paragraphs.map((p) => String(p).trim()).filter(Boolean)
			: [];
		if (!parsed.lede || paragraphs.length < 2) return null;
		return {
			lede: String(parsed.lede).trim(),
			whyRead: String(parsed.whyRead ?? '').trim(),
			paragraphs,
			imagePrompt: String(parsed.imagePrompt ?? '').trim(),
			wantImage: Boolean(parsed.wantImage),
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
	const notes = [
		`PROMPT_VERSION: ${PROMPT_VERSION}`,
		`Story id: ${item.id}`,
		`Source desk: ${source}`,
		`Source label: ${item.source}`,
		`Title: ${item.title}`,
		item.summary ? `Source notes:\n${item.summary}` : 'Source notes: title/meta only — do not invent an abstract.',
		item.meta ? `Signals: ${item.meta}` : '',
		`Original URL (for orientation only, do not scrape): ${item.href}`,
		DESK_BRIEF[source],
		`Write a briefing that could only fit THIS title. Make imagePrompt specific to this story's domain (different objects than a generic sakura still life).`,
	]
		.filter(Boolean)
		.join('\n\n');

	return notes;
}

async function draftFromModel(item: FeedItem, source: DigestSource): Promise<Draft> {
	try {
		const raw = await chatCompletion(
			[
				{ role: 'system', content: SHARED_RULES },
				{ role: 'user', content: buildUserPrompt(item, source) },
			],
			{ maxTokens: 1600, temperature: 0.45, json: true },
		);
		const parsed = extractJson(raw);
		if (!parsed || isWeakDraft(parsed, item.title)) return fallbackDraft(item, source);
		if (!parsed.imagePrompt) parsed.imagePrompt = uniqueFallbackVisual(item, source);
		return parsed;
	} catch (error) {
		console.warn(`[enrich] text failed for ${item.id}:`, error instanceof Error ? error.message : error);
		return fallbackDraft(item, source);
	}
}

function coverPrompt(item: FeedItem, draft: Draft, source: DigestSource) {
	const subject = draft.imagePrompt || uniqueFallbackVisual(item, source);
	return [
		'Unique editorial cover illustration for one engineering newspaper story.',
		'Style: Japanese washi, sumi ink, soft sakura accents, warm ivory light — but the SUBJECT must dominate and differ per story.',
		'No photoreal faces, no text, no letters, no logos, no watermark, no UI chrome.',
		`Story title cue: ${item.title.slice(0, 90)}`,
		`Subject: ${subject}`,
	].join(' ');
}

function shouldGenerateImage(source: DigestSource, draft: Draft, item: FeedItem) {
	if (source === 'papers' || source === 'github') return true;
	if (source === 'hn') {
		if (draft.wantImage) return true;
		const score = item.score ?? 0;
		return score >= 400 || /ai|llm|gpu|kernel|security|database|distributed|rust|paper|arxiv/i.test(item.title);
	}
	if (source === 'x') {
		if (!draft.wantImage) return false;
		const words = `${item.title} ${item.summary ?? ''}`.split(/\s+/).length;
		return words >= 18 || /release|launch|paper|model|gpu|chip|demo|open.?source/i.test(`${item.title} ${item.summary ?? ''}`);
	}
	return Boolean(draft.wantImage);
}

async function copyCover(from: string, id: string): Promise<string | null> {
	try {
		await mkdir(PUBLIC_COVERS, { recursive: true });
		const dest = path.join(PUBLIC_COVERS, `${id}.png`);
		await copyFile(from, dest);
		return `covers/${id}.png`;
	} catch {
		return null;
	}
}

async function ensureCover(item: FeedItem, draft: Draft, source: DigestSource, cached: CacheRow | null): Promise<string | null> {
	const id = storySlug(item.id);
	const seed = seedFromId(`${PROMPT_VERSION}:${item.id}:${item.title}`);

	if (
		cached?.version === PROMPT_VERSION &&
		cached.title === item.title &&
		cached.imageFile &&
		!isWeakDraft(cached.draft, item.title)
	) {
		const cachedPath = path.join(COVER_CACHE, path.basename(cached.imageFile));
		const copied = await copyCover(cachedPath, id);
		if (copied) return copied;
	}

	const dest = path.join(COVER_CACHE, `${id}.png`);
	try {
		await mkdir(COVER_CACHE, { recursive: true });
		const ok = await generateCoverPng(coverPrompt(item, draft, source), dest, { seed });
		if (!ok) return null;
		return copyCover(dest, id);
	} catch (error) {
		console.warn(`[enrich] image failed for ${item.id}:`, error instanceof Error ? error.message : error);
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

async function enrichItem(item: FeedItem, source: DigestSource, withImagePass: boolean): Promise<Story> {
	const id = storySlug(item.id);
	const cached = await readCache(id);
	const cacheOk =
		cached?.version === PROMPT_VERSION &&
		cached.title === item.title &&
		!isWeakDraft(cached.draft, item.title);

	const draft = cacheOk ? cached!.draft : await draftFromModel(item, source);
	const wantCover = shouldGenerateImage(source, draft, item);

	let image: string | null = null;
	if (withImagePass && wantCover) {
		image = await ensureCover(item, draft, source, cacheOk ? cached : null);
	} else if (!withImagePass && cacheOk && cached?.imageFile && wantCover) {
		image = await copyCover(path.join(COVER_CACHE, path.basename(cached.imageFile)), id);
	}

	await writeCache({
		id,
		title: item.title,
		version: PROMPT_VERSION,
		draft,
		imageFile: image ? `${id}.png` : wantCover ? cached?.imageFile ?? null : null,
	});

	const paragraphs = draft.paragraphs.length ? draft.paragraphs : fallbackDraft(item, source).paragraphs;
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
		paragraphs,
		originalHref: item.href,
		image: wantCover ? image : null,
		stats: statsFromMeta(item.meta),
		meta: `${minutesFor(paragraphs)} min read`,
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

	const drafted = await mapPool([...unique.values()], TEXT_CONCURRENCY, (job) =>
		enrichItem(job.item, job.source, false),
	);
	const withCovers = await mapPool(drafted, IMAGE_CONCURRENCY, async (story) => {
		const job = unique.get(story.id);
		if (!job) return story;
		return enrichItem(job.item, job.source, true);
	});
	const byId = new Map(withCovers.map((story) => [story.id, story]));

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
	const withImages = withCovers.filter((s) => s.image).length;
	console.log(`[enrich] wrote ${withCovers.length} stories (digest ${catalog.digest.length}, covers ${withImages})`);
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
