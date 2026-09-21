import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DigestSource } from '../data/digest';
import { CATALOG_PATH, storySlug, type Story, type StoryCatalog } from './catalog';
import { TEXT_MODEL, chatCompletion, generateCoverPng, hasTextKey } from './ai';
import {
	fetchHackerNews,
	fetchHottestGithubToday,
	fetchPapers,
	fetchXTimeline,
	type FeedItem,
} from './feeds';

const CACHE_DIR = path.join(process.cwd(), '.cache/stories');
const COVER_CACHE = path.join(process.cwd(), '.cache/covers');
const PUBLIC_COVERS = path.join(process.cwd(), 'public/covers');

const TEXT_CONCURRENCY = 2;
const IMAGE_CONCURRENCY = 1;

const SYSTEM_PROMPT = `You write original briefings for AweSam, a technical digest for systems, AI, and programming practitioners.

Rules:
- Never copy, quote, or closely paraphrase the source. Transform it into a new editorial briefing.
- Do not invent numbers, benchmarks, quotes, authors, or paper results that are not in the source notes.
- If the source is thin (a tweet or a title), stay honest: explain why the signal matters, what to inspect, and what a careful engineer should verify.
- Voice: precise, concrete, slightly literary. Second person is welcome. No hype, no "delve", no "in today's fast-paced world".
- Length: a 2–3 minute read (about 320–480 words across 3–5 short paragraphs).

Return ONLY compact JSON with keys:
{
  "lede": "40-55 words for the card. Why a senior engineer should care.",
  "whyRead": "one sentence",
  "paragraphs": ["paragraph 1", "paragraph 2", "..."],
  "imagePrompt": "one visual sentence describing a scene, objects, and mood. No words, letters, logos, or UI in the image."
}`;

type Draft = {
	lede: string;
	whyRead: string;
	paragraphs: string[];
	imagePrompt: string;
};

type CacheRow = {
	id: string;
	title: string;
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

function fallbackDraft(item: FeedItem): Draft {
	const lede =
		item.summary?.trim() ||
		`A closer look at ${item.title} — what a systems-minded reader should notice, and why it showed up on the wire.`;
	return {
		lede: lede.slice(0, 280),
		whyRead: `Read this to understand the shape of “${item.title}” before opening the original.`,
		paragraphs: [
			lede,
			`This briefing is a map, not a substitute for the primary source. The original ${item.source} post is where the details, discussion, and updates live.`,
			`Use it to decide whether the idea belongs in your stack, your reading queue, or your list of things to verify. Then follow the original link at the end of this note.`,
		],
		imagePrompt: `Quiet editorial still life about software craft: ink, paper, a faint circuit or branch motif, warm side light, no people.`,
	};
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
			imagePrompt: String(parsed.imagePrompt ?? '').trim(),
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

async function draftFromModel(item: FeedItem, source: DigestSource): Promise<Draft> {
	const notes = [
		`Source desk: ${source} (${item.source})`,
		`Title: ${item.title}`,
		item.summary ? `Source notes: ${item.summary}` : 'Source notes: title only — do not invent a paper abstract.',
		item.meta ? `Signals: ${item.meta}` : '',
	]
		.filter(Boolean)
		.join('\n');

	const user = `Write an original AweSam briefing from these notes. Do not reproduce the source.\n\n${notes}`;

	try {
		const raw = await chatCompletion(
			[
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: user },
			],
			{ maxTokens: 1100, temperature: 0.35 },
		);
		return extractJson(raw) ?? fallbackDraft(item);
	} catch (error) {
		console.warn(`[enrich] text failed for ${item.id}:`, error instanceof Error ? error.message : error);
		return fallbackDraft(item);
	}
}

function coverPrompt(item: FeedItem, draft: Draft) {
	const subject = draft.imagePrompt || `an abstract scene inspired by “${item.title}”`;
	return [
		'Editorial illustration for an engineering newspaper.',
		'Japanese washi paper, sumi ink linework, muted sakura pink petals, moss-green leaves, warm ivory light.',
		'Cinematic, tactile, no photoreal faces, no text, no letters, no logos, no watermark, no UI chrome.',
		`Subject: ${subject}`,
	].join(' ');
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

async function ensureCover(item: FeedItem, draft: Draft, cached: CacheRow | null): Promise<string | null> {
	const id = storySlug(item.id);
	if (cached?.title === item.title && cached.imageFile) {
		const cachedPath = path.join(COVER_CACHE, path.basename(cached.imageFile));
		const copied = await copyCover(cachedPath, id);
		if (copied) return copied;
	}

	const dest = path.join(COVER_CACHE, `${id}.png`);
	try {
		await mkdir(COVER_CACHE, { recursive: true });
		const ok = await generateCoverPng(coverPrompt(item, draft), dest);
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

async function enrichItem(item: FeedItem, source: DigestSource, withImage: boolean): Promise<Story> {
	const id = storySlug(item.id);
	const cached = await readCache(id);
	const draft = cached?.title === item.title ? cached.draft : await draftFromModel(item, source);
	const image = withImage ? await ensureCover(item, draft, cached) : cached?.title === item.title && cached.imageFile
		? await copyCover(path.join(COVER_CACHE, path.basename(cached.imageFile)), id)
		: null;

	await writeCache({
		id,
		title: item.title,
		draft,
		imageFile: image ? `${id}.png` : cached?.imageFile ?? null,
	});

	const paragraphs = draft.paragraphs.length ? draft.paragraphs : fallbackDraft(item).paragraphs;
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
		image,
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
	console.log(`[enrich] text=${TEXT_MODEL} groq=${hasTextKey() ? 'yes' : 'no'}`);

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
	console.log(
		`[enrich] wrote ${withCovers.length} stories (digest ${catalog.digest.length})`,
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
