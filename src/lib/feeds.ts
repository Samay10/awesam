import { clip } from './plain';

export type FeedItem = {
	id: string;
	title: string;
	href: string;
	source: string;
	meta: string;
	summary?: string;
	score?: number;
};

const HN_KEYWORDS = [
	'ai',
	'llm',
	'gpt',
	'agent',
	'distributed',
	'system',
	'database',
	'compiler',
	'kernel',
	'rust',
	'python',
	'open source',
	'github',
	'latency',
	'throughput',
	'paper',
	'arxiv',
	'yc',
	'startup',
	'security',
];

const X_LISTEN = [
	// Labs & orgs
	{ handle: 'OpenAI', label: 'OpenAI', weight: 3 },
	{ handle: 'AnthropicAI', label: 'Anthropic', weight: 3 },
	{ handle: 'GoogleDeepMind', label: 'Google DeepMind', weight: 3 },
	{ handle: 'AIatMeta', label: 'Meta AI', weight: 2 },
	{ handle: 'nvidia', label: 'NVIDIA', weight: 3 },
	{ handle: 'AMD', label: 'AMD', weight: 2 },
	{ handle: 'intel', label: 'Intel', weight: 2 },
	{ handle: 'PyTorch', label: 'PyTorch', weight: 2 },
	{ handle: 'lmsysorg', label: 'LMSYS', weight: 2 },
	// People
	{ handle: 'karpathy', label: 'Andrej Karpathy', weight: 3 },
	{ handle: 'sama', label: 'Sam Altman', weight: 2 },
	{ handle: 'ylecun', label: 'Yann LeCun', weight: 3 },
	{ handle: 'gdb', label: 'Greg Brockman', weight: 2 },
	{ handle: 'demishassabis', label: 'Demis Hassabis', weight: 3 },
	{ handle: 'AndrewYNg', label: 'Andrew Ng', weight: 2 },
	{ handle: 'fchollet', label: 'François Chollet', weight: 2 },
	{ handle: 'cHHillee', label: 'Horace He', weight: 2 },
	{ handle: 'mitchellh', label: 'Mitchell Hashimoto', weight: 2 },
] as const;

/** Tech signal words — AI, systems, hardware, software. */
const X_RELEVANCE = [
	'ai',
	'llm',
	'gpt',
	'claude',
	'gemini',
	'model',
	'agent',
	'inference',
	'training',
	'transformer',
	'diffusion',
	'embedding',
	'benchmark',
	'eval',
	'gpu',
	'cuda',
	'tpu',
	'npu',
	'chip',
	'silicon',
	'hardware',
	'nvidia',
	'amd',
	'intel',
	'kernel',
	'compiler',
	'distributed',
	'systems',
	'latency',
	'throughput',
	'rust',
	'python',
	'pytorch',
	'cuda',
	'open source',
	'opensource',
	'release',
	'paper',
	'arxiv',
	'research',
	'safety',
	'alignment',
	'devops',
	'infrastructure',
	'software',
	'api',
	'sdk',
	'runtime',
	'vector',
	'database',
	'orchestration',
];

const X_NOISE = [
	'giveaway',
	'follow me',
	'follow back',
	'nft',
	'crypto pump',
	'airdrop',
	'meme coin',
	'subscribe for',
	'only fans',
];


function isoDate(daysAgo: number) {
	const date = new Date();
	date.setUTCDate(date.getUTCDate() - daysAgo);
	return date.toISOString().slice(0, 10);
}

function clean(text: string, max = 220) {
	return clip(text, max);
}

function feedBody(node: string, max: number) {
	const encoded =
		node.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i)?.[1] ??
		node.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] ??
		'';
	const desc = xmlTag(node, 'description') || xmlTag(node, 'summary');
	const raw = encoded.length > desc.length ? encoded : desc;
	return clip(raw, max);
}

function matchesAny(text: string, words: string[]) {
	const hay = text.toLowerCase();
	return words.some((word) => hay.includes(word));
}

function relevanceScore(text: string, weight = 1) {
	const hay = text.toLowerCase();
	if (matchesAny(hay, X_NOISE)) return -100;
	let score = weight;
	for (const word of X_RELEVANCE) {
		if (hay.includes(word)) score += word.length > 3 ? 3 : 2;
	}
	// Prefer concrete development language over vague hype.
	if (/\b(releas|ship|launch|announce|open[- ]sourc|paper|benchmark|latency|throughput|kernel|gpu|model)\w*/i.test(text)) {
		score += 4;
	}
	return score;
}

function githubAuthHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
	try {
		const onGithub = /api\.github\.com/i.test(url);
		const response = await fetch(url, {
			...init,
			headers: {
				Accept: 'application/json',
				'User-Agent': 'AweSam/1.0 (https://samay10.github.io/awesam/; mailto:sam10ashar@gmail.com)',
				...(onGithub ? githubAuthHeaders() : {}),
				...init?.headers,
			},
		});
		if (!response.ok) {
			if (onGithub) {
				console.warn(`[feeds] GitHub ${response.status} for ${url.split('?')[0]}`);
			}
			return null;
		}
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

async function fetchText(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, {
			headers: {
				Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, text/html',
				'User-Agent': 'AweSam/1.0 (https://samay10.github.io/awesam/)',
			},
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) return null;
		return await response.text();
	} catch {
		return null;
	}
}

function xmlTag(block: string, tag: string) {
	const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
	return match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() ?? '';
}

function parseAtomEntries(xml: string) {
	return [...xml.matchAll(/<entry[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
}

function parseRssItems(xml: string) {
	return [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map((match) => match[0]);
}

type HnStory = {
	id: number;
	title?: string;
	url?: string;
	score?: number;
	by?: string;
	descendants?: number;
	type?: string;
	text?: string;
};

/** Live “best of HN” via Firebase REST — https://github.com/HackerNews/API */
export async function fetchHackerNews(limit = 12): Promise<FeedItem[]> {
	const ids = (await fetchJson<number[]>('https://hacker-news.firebaseio.com/v0/beststories.json')) ?? [];
	if (!ids.length) return [];

	// Pull a wider window so we can prefer systems/AI-relevant titles while staying in beststories order.
	const window = Math.min(ids.length, Math.max(limit * 4, 40));
	const stories = (
		await Promise.all(ids.slice(0, window).map((id) => fetchJson<HnStory>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)))
	).filter((story): story is HnStory => Boolean(story?.title && story.type === 'story' && !story.url?.includes('ycombinator.com/jobs')));

	const ranked = stories
		.map((story, index) => {
			const title = story.title ?? '';
			const relevant = matchesAny(title, HN_KEYWORDS);
			return { story, index, relevant };
		})
		.sort((a, b) => Number(b.relevant) - Number(a.relevant) || a.index - b.index)
		.slice(0, limit)
		.map(({ story }) => {
			const title = story.title ?? '';
			const summary = story.text ? clean(story.text.replace(/<[^>]+>/g, ' '), 200) : undefined;
			return {
				id: `hn-${story.id}`,
				title,
				href: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
				source: 'Hacker News',
				meta: `${story.score ?? 0} pts · ${story.by ?? 'anon'} · ${story.descendants ?? 0} comments`,
				summary,
				score: story.score ?? 0,
			} satisfies FeedItem;
		});

	return ranked;
}

type GithubRepo = {
	id: number;
	full_name: string;
	html_url: string;
	description: string | null;
	stargazers_count: number;
	language: string | null;
};

export async function fetchGithubRepos(limit = 12): Promise<FeedItem[]> {
	const since = isoDate(10);
	const query = encodeURIComponent(`created:>${since} stars:>20`);
	const payload = await fetchJson<{ items?: GithubRepo[] }>(
		`https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=${Math.min(limit, 30)}`,
		{ headers: { 'X-GitHub-Api-Version': '2022-11-28' } },
	);

	return (payload?.items ?? []).slice(0, limit).map(mapGithubRepo);
}

/** Hottest rising repos in the last ~48h (star proxy for “of the day”). */
export async function fetchHottestGithubToday(limit = 10): Promise<FeedItem[]> {
	const since = isoDate(1);
	const payload = await fetchJson<{ items?: GithubRepo[] }>(
		`https://api.github.com/search/repositories?q=${encodeURIComponent(`created:>=${since} stars:>5`)}&sort=stars&order=desc&per_page=30`,
		{ headers: { 'X-GitHub-Api-Version': '2022-11-28' } },
	);

	let items = rankGithubHot(payload?.items ?? [], limit);
	if (items.length < limit) {
		const week = await fetchJson<{ items?: GithubRepo[] }>(
			`https://api.github.com/search/repositories?q=${encodeURIComponent(`created:>=${isoDate(7)} stars:>30`)}&sort=stars&order=desc&per_page=30`,
			{ headers: { 'X-GitHub-Api-Version': '2022-11-28' } },
		);
		const merged = new Map<string, FeedItem>();
		for (const item of [...items, ...rankGithubHot(week?.items ?? [], limit * 2)]) {
			merged.set(item.id, item);
		}
		items = [...merged.values()].slice(0, limit);
	}

	if (items.length < limit) {
		const broad = await fetchGithubRepos(limit);
		const merged = new Map<string, FeedItem>();
		for (const item of [...items, ...broad]) merged.set(item.id, item);
		items = [...merged.values()].slice(0, limit);
	}

	console.log(`[feeds] github hot repos: ${items.length}`);
	return items;
}

function rankGithubHot(repos: GithubRepo[], limit: number): FeedItem[] {
	const tech = [
		'ai',
		'llm',
		'gpt',
		'model',
		'agent',
		'rust',
		'python',
		'typescript',
		'cuda',
		'gpu',
		'kernel',
		'infra',
		'system',
		'compiler',
		'database',
		'distributed',
		'openai',
		'pytorch',
		'inference',
		'sdk',
		'cli',
		'devtool',
		'framework',
	];

	return repos
		.map(mapGithubRepo)
		.map((item) => {
			const hay = `${item.title} ${item.summary ?? ''} ${item.meta}`.toLowerCase();
			const noise = /awesome-|curriculum|homework|course|minecraft|tutorial-only/.test(hay);
			const hits = tech.filter((word) => hay.includes(word)).length;
			return { item, noise, hits, score: (item.score ?? 0) + hits * 80 - (noise ? 10_000 : 0) };
		})
		.filter((row) => !row.noise)
		.sort((a, b) => b.score - a.score || b.hits - a.hits)
		.slice(0, limit)
		.map((row) => row.item);
}

function mapGithubRepo(repo: GithubRepo): FeedItem {
	return {
		id: `gh-${repo.id}`,
		title: repo.full_name,
		href: repo.html_url,
		source: 'GitHub',
		meta: `${repo.stargazers_count.toLocaleString()} ★ · ${repo.language ?? 'polyglot'}`,
		summary: repo.description ? clean(repo.description, 160) : undefined,
		score: repo.stargazers_count,
	};
}

/** Flagship repos watched by the live PR pulse. */
export const GITHUB_WATCH_REPOS = [
	'openclaw/openclaw',
	'microsoft/vscode',
	'microsoft/TypeScript',
	'facebook/react',
	'pytorch/pytorch',
	'kubernetes/kubernetes',
	'vercel/next.js',
	'rust-lang/rust',
	'openai/openai-python',
	'golang/go',
] as const;

export type GithubPullSignal = {
	id: string;
	repo: string;
	number: number;
	title: string;
	href: string;
	user: string;
	updatedAt: string;
	state: string;
};

export type GithubRepoPulse = {
	repo: string;
	owner: string;
	name: string;
	href: string;
	avatar: string;
	pulls: GithubPullSignal[];
};

type GithubPull = {
	id: number;
	number: number;
	title: string;
	html_url: string;
	state: string;
	updated_at: string;
	user?: { login?: string } | null;
};

export function githubRepoMeta(repo: string): Pick<GithubRepoPulse, 'repo' | 'owner' | 'name' | 'href' | 'avatar'> {
	const [owner, name] = repo.split('/');
	return {
		repo,
		owner: owner ?? repo,
		name: name ?? repo,
		href: `https://github.com/${repo}`,
		avatar: `https://github.com/${owner}.png?size=80`,
	};
}

function mapGithubPulls(repo: string, pulls: GithubPull[] | null | undefined, limit = 3): GithubPullSignal[] {
	return (pulls ?? []).slice(0, limit).map((pull) => ({
		id: `pr-${repo}-${pull.number}`,
		repo,
		number: pull.number,
		title: pull.title,
		href: pull.html_url,
		user: pull.user?.login ?? 'unknown',
		updatedAt: pull.updated_at,
		state: pull.state,
	}));
}

/** Seed The Big Guns grid at build time — top 3 recent PRs per watched repo. */
export async function fetchGithubWatchPulls(): Promise<GithubRepoPulse[]> {
	const rows = await Promise.all(
		GITHUB_WATCH_REPOS.map(async (repo) => {
			const pulls = await fetchJson<GithubPull[]>(
				`https://api.github.com/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=3`,
				{ headers: { 'X-GitHub-Api-Version': '2022-11-28' } },
			);
			return {
				...githubRepoMeta(repo),
				pulls: mapGithubPulls(repo, pulls, 3),
			};
		}),
	);

	return rows;
}

export async function fetchPapers(limit = 12): Promise<FeedItem[]> {
	const [arxiv, conferences, orgs] = await Promise.all([
		fetchArxivPapers(Math.max(limit, 18)),
		fetchOpenAlexConferencePapers(16),
		fetchOpenAlexOrgPapers(16),
	]);

	const seen = new Set<string>();
	const merged = [...conferences, ...orgs, ...arxiv]
		.filter((item) => {
			const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
			if (!key || seen.has(key)) return false;
			if (PAPER_NOISE.test(`${item.title} ${item.summary ?? ''} ${item.meta}`)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

	return diversifyPapers(merged, limit);
}

function diversifyPapers(items: FeedItem[], limit: number): FeedItem[] {
	const picks: FeedItem[] = [];
	const take = (predicate: (item: FeedItem) => boolean, n: number) => {
		for (const item of items) {
			if (picks.length >= limit || n <= 0) return;
			if (!predicate(item)) continue;
			if (picks.some((row) => row.id === item.id)) continue;
			picks.push(item);
			n -= 1;
		}
	};

	take((item) => /neurips|iclr|icml/i.test(item.source), 4);
	take((item) => /arxiv/i.test(item.source), 8);
	take((item) => /acl|emnlp|cvpr|aaai|lab|org/i.test(item.source), 6);
	take(() => true, limit);
	return picks.slice(0, limit);
}

const PAPER_VENUES = [
	{ id: 'S4210191458', label: 'AAAI', weight: 8 },
	{ id: 'S4306420609', label: 'NeurIPS', weight: 10 },
	{ id: 'S4306419637', label: 'ICLR', weight: 10 },
	{ id: 'S4306419644', label: 'ICML', weight: 10 },
	{ id: 'S4306420508', label: 'ACL', weight: 8 },
	{ id: 'S4306418267', label: 'EMNLP', weight: 8 },
] as const;

const PAPER_ORGS = [
	'I4210161460', // OpenAI
	'I4210090411', // Google DeepMind
	'I1291425158', // Google
	'I4210114444', // Meta US
	'I2252078561', // Meta IL
	'I97018004', // Stanford
	'I63966007', // MIT
	'I95457486', // Berkeley
	'I4210164937', // Microsoft Research UK
] as const;

const PAPER_CONCEPTS = [
	'C119857082', // Machine learning
	'C154945302', // Artificial intelligence
	'C108583219', // Deep learning
].join('|');

const PAPER_NOISE =
	/\b(bmj|lancet|jama|consort|spirit|probast|stard-ai|drug development|diagnostic accuracy|cancer|cardiology|remote sensing|pansharpening|sleep staging)\b/i;

const VENUE_HINTS: { re: RegExp; label: string; weight: number }[] = [
	{ re: /\bneurips\b|\bnips\b/i, label: 'NeurIPS', weight: 10 },
	{ re: /\biclr\b/i, label: 'ICLR', weight: 10 },
	{ re: /\bicml\b/i, label: 'ICML', weight: 10 },
	{ re: /\bcvpr\b/i, label: 'CVPR', weight: 9 },
	{ re: /\biccv\b/i, label: 'ICCV', weight: 8 },
	{ re: /\beccv\b/i, label: 'ECCV', weight: 8 },
	{ re: /\baaa[iı]\b/i, label: 'AAAI', weight: 8 },
	{ re: /\bemnlp\b/i, label: 'EMNLP', weight: 8 },
	{ re: /\bacl\b/i, label: 'ACL', weight: 8 },
	{ re: /\bkdd\b/i, label: 'KDD', weight: 7 },
	{ re: /\bjmlr\b/i, label: 'JMLR', weight: 7 },
];

type OpenAlexWork = {
	id: string;
	display_name?: string;
	publication_date?: string;
	cited_by_count?: number;
	doi?: string | null;
	primary_location?: {
		landing_page_url?: string | null;
		pdf_url?: string | null;
		source?: { display_name?: string | null } | null;
	} | null;
	authorships?: { author?: { display_name?: string | null } | null }[];
	abstract_inverted_index?: Record<string, number[]> | null;
};

function openAlexMailto() {
	return 'mailto=sam10ashar@gmail.com';
}

function reconstructAbstract(index?: Record<string, number[]> | null) {
	if (!index) return '';
	const slots: { word: string; pos: number }[] = [];
	for (const [word, positions] of Object.entries(index)) {
		for (const pos of positions) slots.push({ word, pos });
	}
	return slots
		.sort((a, b) => a.pos - b.pos)
		.map((slot) => slot.word)
		.join(' ');
}

function venueFromText(...parts: (string | null | undefined)[]) {
	const hay = parts.filter(Boolean).join(' · ');
	for (const hint of VENUE_HINTS) {
		if (hint.re.test(hay)) return hint;
	}
	return null;
}

function mapOpenAlexWork(work: OpenAlexWork, fallbackLabel: string, baseWeight: number): FeedItem | null {
	const title = work.display_name?.trim();
	if (!title) return null;

	const sourceName = work.primary_location?.source?.display_name ?? '';
	const abstract = reconstructAbstract(work.abstract_inverted_index);
	const venue = venueFromText(title, sourceName, abstract, fallbackLabel);
	const label = venue?.label ?? fallbackLabel;
	const authors = (work.authorships ?? [])
		.map((row) => row.author?.display_name)
		.filter(Boolean)
		.slice(0, 2)
		.join(', ');
	const date = work.publication_date ?? '';
	const cites = work.cited_by_count ?? 0;
	const href =
		work.primary_location?.landing_page_url ||
		work.primary_location?.pdf_url ||
		(work.doi ? `https://doi.org/${work.doi.replace(/^https?:\/\/doi\.org\//, '')}` : '') ||
		work.id;
	const recencyBoost = date.startsWith('2026') ? 40 : date.startsWith('2025') ? 20 : 0;
	const score = baseWeight * 12 + (venue?.weight ?? 0) * 10 + Math.min(cites, 400) / 4 + recencyBoost;

	return {
		id: `oa-${work.id.split('/').pop()}`,
		title: clean(title, 140),
		href,
		source: label,
		meta: [authors || label, date, cites ? `${cites} cites` : ''].filter(Boolean).join(' · '),
		summary: abstract ? clean(abstract, 200) : undefined,
		score,
	};
}

async function fetchOpenAlexWorks(filter: string, perPage: number): Promise<OpenAlexWork[]> {
	const url =
		`https://api.openalex.org/works?filter=${encodeURIComponent(filter)}` +
		`&sort=cited_by_count:desc&per_page=${perPage}&select=id,display_name,publication_date,cited_by_count,doi,primary_location,authorships,abstract_inverted_index` +
		`&${openAlexMailto()}`;
	const payload = await fetchJson<{ results?: OpenAlexWork[] }>(url);
	return payload?.results ?? [];
}

async function fetchOpenAlexConferencePapers(limit: number): Promise<FeedItem[]> {
	const sourceFilter = PAPER_VENUES.map((venue) => venue.id).join('|');
	const works = await fetchOpenAlexWorks(
		`locations.source.id:${sourceFilter},from_publication_date:${isoDate(400)},concepts.id:${PAPER_CONCEPTS}`,
		Math.min(limit * 2, 25),
	);

	return works
		.map((work) => {
			const sourceName = work.primary_location?.source?.display_name ?? '';
			const matched = PAPER_VENUES.find((venue) => sourceName.toLowerCase().includes(venue.label.toLowerCase()));
			const fallback = matched?.label ?? venueFromText(sourceName)?.label ?? 'Conference';
			const weight = matched?.weight ?? venueFromText(sourceName)?.weight ?? 6;
			return mapOpenAlexWork(work, fallback, weight);
		})
		.filter((item): item is FeedItem => Boolean(item));
}

async function fetchOpenAlexOrgPapers(limit: number): Promise<FeedItem[]> {
	const works = await fetchOpenAlexWorks(
		`institutions.id:${PAPER_ORGS.join('|')},concepts.id:${PAPER_CONCEPTS},from_publication_date:${isoDate(200)},type:article|preprint`,
		Math.min(limit * 2, 25),
	);

	return works
		.map((work) => mapOpenAlexWork(work, 'Lab / Org', 7))
		.filter((item): item is FeedItem => Boolean(item));
}

async function fetchArxivPapers(limit: number): Promise<FeedItem[]> {
	const xml = await fetchText(
		`https://export.arxiv.org/api/query?search_query=cat:cs.LG+OR+cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.CV+OR+cat:cs.DC&sortBy=submittedDate&sortOrder=descending&max_results=${Math.min(limit * 2, 30)}`,
	);
	if (!xml) return [];

	return parseAtomEntries(xml)
		.slice(0, limit * 2)
		.map((entry, index) => {
			const title = xmlTag(entry, 'title');
			const summary = xmlTag(entry, 'summary');
			const published = xmlTag(entry, 'published');
			const href =
				entry.match(/<link[^>]+rel="alternate"[^>]+href="([^"]+)"/i)?.[1] ||
				xmlTag(entry, 'id').replace('http://', 'https://');
			const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/gi)]
				.map((match) => match[1].trim())
				.slice(0, 2)
				.join(', ');
			const date = published ? published.slice(0, 10) : '';
			const venue = venueFromText(title, summary);
			const score = 35 + (venue?.weight ?? 0) * 8 + (date.startsWith(isoDate(0).slice(0, 7)) ? 15 : 0);

			return {
				id: `arxiv-${href || index}`,
				title: clean(title, 140),
				href,
				source: venue ? `arXiv · ${venue.label}` : 'arXiv',
				meta: [authors, date].filter(Boolean).join(' · '),
				summary: summary ? clean(summary, 200) : undefined,
				score,
			} satisfies FeedItem;
		})
		.filter((item) => item.title && !PAPER_NOISE.test(`${item.title} ${item.summary ?? ''}`));
}

function parseFeedNodes(xml: string) {
	const rss = parseRssItems(xml);
	return rss.length ? rss : parseAtomEntries(xml);
}

function statusIdFromHref(href: string, handle: string, index: number) {
	const match = href.match(/status\/(\d+)/i);
	return match ? `x-${match[1]}` : `x-${handle}-${index}`;
}

function feedLink(node: string) {
	const hrefAttr = node.match(/<link[^>]+href="([^"]+)"/i)?.[1];
	const plain = xmlTag(node, 'link');
	const candidate = (hrefAttr || plain || '').trim();
	return candidate.startsWith('http') ? candidate : '';
}

function hashId(prefix: string, value: string) {
	let hash = 0;
	for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
	return `${prefix}-${hash.toString(36)}`;
}

const PRESS_FEEDS = [
	{ label: 'WIRED', url: 'https://www.wired.com/feed/rss', weight: 3 },
	{ label: 'TechCrunch', url: 'https://techcrunch.com/feed/', weight: 3 },
	{ label: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', weight: 3 },
] as const;

const REDDIT_FEEDS = [
	{ label: 'r/programming', url: 'https://www.reddit.com/r/programming/.rss', weight: 3 },
	{ label: 'r/MachineLearning', url: 'https://www.reddit.com/r/MachineLearning/.rss', weight: 3 },
	{ label: 'r/technology', url: 'https://www.reddit.com/r/technology/.rss', weight: 2 },
	{ label: 'r/artificial', url: 'https://www.reddit.com/r/artificial/.rss', weight: 2 },
] as const;

const PRESS_KEYWORDS = [
	...HN_KEYWORDS,
	'startup',
	'chip',
	'semiconductor',
	'apple',
	'google',
	'meta',
	'microsoft',
	'openai',
	'anthropic',
	'cyber',
	'privacy',
	'cloud',
	'software',
	'app',
	'iphone',
	'android',
];

async function fetchRssOutlet(
	label: string,
	url: string,
	weight: number,
	prefix: string,
): Promise<FeedItem[]> {
	const xml = await fetchText(url);
	if (!xml) return [];

	return parseFeedNodes(xml)
		.slice(0, 12)
		.map((node, index) => {
			const title = clean(xmlTag(node, 'title'), 140);
			const summary = feedBody(node, prefix === 'reddit' ? 1600 : 700) || title;
			const href = feedLink(node) || url;
			const date = (xmlTag(node, 'pubDate') || xmlTag(node, 'updated') || xmlTag(node, 'published') || '').slice(0, 25);
			const score = relevanceScore(`${title} ${summary}`, weight);
			if (!title || !href.startsWith('http')) return null;
			return {
				id: hashId(prefix, href || `${label}-${index}`),
				title,
				href,
				source: label,
				meta: [label, date].filter(Boolean).join(' · '),
				summary,
				score,
			} satisfies FeedItem;
		})
		.filter((item): item is FeedItem => Boolean(item && (item.score ?? 0) >= 4));
}

/** WIRED · TechCrunch · The Verge — tech press RSS. */
export async function fetchPressNews(limit = 8): Promise<FeedItem[]> {
	const batches = await Promise.all(
		PRESS_FEEDS.map(({ label, url, weight }) => fetchRssOutlet(label, url, weight, 'press')),
	);
	const seen = new Set<string>();
	return batches
		.flat()
		.filter((item) => {
			if (seen.has(item.id) || seen.has(item.href)) return false;
			seen.add(item.id);
			seen.add(item.href);
			return matchesAny(`${item.title} ${item.summary ?? ''}`, PRESS_KEYWORDS);
		})
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
		.slice(0, limit);
}

/** Reddit programming / ML / tech / AI. */
export async function fetchRedditTech(limit = 6): Promise<FeedItem[]> {
	const batches = await Promise.all(
		REDDIT_FEEDS.map(({ label, url, weight }) => fetchRssOutlet(label, url, weight, 'reddit')),
	);
	const seen = new Set<string>();
	return batches
		.flat()
		.filter((item) => {
			if (seen.has(item.id) || seen.has(item.href)) return false;
			// Drop pure self-promo megathreads and non-tech fluff when possible.
			if (/daily discussion|megathread|what are you working/i.test(item.title)) return false;
			seen.add(item.id);
			seen.add(item.href);
			return true;
		})
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
		.slice(0, limit);
}

/**
 * X has no free public API for new apps (pay-per-use only).
 * We syndicate curated handles via FxEmbed RSS: https://docs.fxembed.com/guide/advanced/rss-atom-feeds/
 */
async function fetchHandleFeed(
	handle: string,
	label: string,
	weight: number,
): Promise<FeedItem[]> {
	const urls = [
		`https://fxtwitter.com/${handle}/feed.xml?count=8&safe=1`,
		`https://fixupx.com/${handle}/feed.xml?count=8&safe=1`,
		`https://rsshub.app/twitter/user/${handle}`,
	];

	for (const url of urls) {
		const xml = await fetchText(url);
		if (!xml || (!xml.includes('<item') && !xml.includes('<entry'))) continue;

		return parseFeedNodes(xml)
			.slice(0, 8)
			.map((node, index) => {
				const rawTitle = xmlTag(node, 'title') || xmlTag(node, 'description');
				const full = clean(rawTitle.replace(/^RT\s+@?\w+:\s*/i, ''), 280);
				const body = feedBody(node, 900).replace(/^RT\s+@?\w+:\s*/i, '');
				const title = clean(full, 96);
				const summary = body.length >= full.length ? body : full;
				const href =
					xmlTag(node, 'link') ||
					node.match(/<link[^>]+href="([^"]+)"/i)?.[1] ||
					`https://x.com/${handle}`;
				const normalizedHref = href.startsWith('http') ? href.replace('twitter.com', 'x.com') : `https://x.com/${handle}`;
				const ownPost = new RegExp(`x\\.com/${handle}/status/`, 'i').test(normalizedHref);
				if (!ownPost) return null;
				const date = (xmlTag(node, 'pubDate') || xmlTag(node, 'published') || '').slice(0, 25);
				const score = relevanceScore(`${full} ${summary}`, weight);
				return {
					id: statusIdFromHref(normalizedHref, handle, index),
					title,
					href: normalizedHref,
					source: `@${handle}`,
					meta: [label, date].filter(Boolean).join(' · '),
					summary,
					score,
				} satisfies FeedItem;
			})
			.filter((item): item is FeedItem => Boolean(item?.title && (item.score ?? 0) >= 5));
	}

	return [];
}

export async function fetchXTimeline(limit = 12): Promise<FeedItem[]> {
	const batches = await Promise.all(
		X_LISTEN.map(({ handle, label, weight }) => fetchHandleFeed(handle, label, weight)),
	);

	const seen = new Set<string>();
	const live = batches
		.flat()
		.filter((item) => {
			if (!item.title || !item.href) return false;
			if (seen.has(item.id)) return false;
			seen.add(item.id);
			return true;
		})
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

	if (live.length > 0) {
		return live.slice(0, limit);
	}

	// Syndication quiet — keep section useful with the curated listen list.
	return X_LISTEN.map(({ handle, label }, index) => ({
		id: `x-listen-${handle}`,
		title: `Follow ${label} on X`,
		href: `https://x.com/${handle}`,
		source: `@${handle}`,
		meta: 'Curated AI / systems listen list',
		summary: 'Live X syndication was quiet — open the profile for the latest posts.',
		score: X_LISTEN.length - index,
	}));
}

export async function loadDigest(limitPer = 3) {
	const [hn, github, papers, x] = await Promise.all([
		fetchHackerNews(limitPer),
		fetchGithubRepos(limitPer),
		fetchPapers(limitPer),
		fetchXTimeline(limitPer),
	]);

	return { hn, github, papers, x };
}
