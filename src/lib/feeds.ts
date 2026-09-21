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
	const next = decodeXml(text).replace(/\s+/g, ' ').trim();
	return next.length > max ? `${next.slice(0, max - 1)}…` : next;
}

function decodeXml(text: string) {
	return text
		.replace(/<!\[CDATA\[|\]\]>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
	try {
		const response = await fetch(url, {
			...init,
			headers: {
				Accept: 'application/json',
				'User-Agent': 'AweSam/1.0 (https://samay10.github.io/awesam/)',
				...init?.headers,
			},
		});
		if (!response.ok) return null;
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
export async function fetchHottestGithubToday(limit = 6): Promise<FeedItem[]> {
	const since = isoDate(1);
	const payload = await fetchJson<{ items?: GithubRepo[] }>(
		`https://api.github.com/search/repositories?q=${encodeURIComponent(`created:>=${since} stars:>10`)}&sort=stars&order=desc&per_page=30`,
		{ headers: { 'X-GitHub-Api-Version': '2022-11-28' } },
	);

	let items = rankGithubHot(payload?.items ?? [], limit);
	if (items.length < limit) {
		const fallback = await fetchJson<{ items?: GithubRepo[] }>(
			`https://api.github.com/search/repositories?q=${encodeURIComponent(`created:>=${isoDate(5)} stars:>40`)}&sort=stars&order=desc&per_page=30`,
			{ headers: { 'X-GitHub-Api-Version': '2022-11-28' } },
		);
		items = rankGithubHot(fallback?.items ?? [], limit);
	}

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

type GithubPull = {
	id: number;
	number: number;
	title: string;
	html_url: string;
	state: string;
	updated_at: string;
	user?: { login?: string } | null;
};

/** Seed the live pulse at build time (one request per watched repo). */
export async function fetchGithubWatchPulls(): Promise<GithubPullSignal[]> {
	const batches = await Promise.all(
		GITHUB_WATCH_REPOS.map(async (repo) => {
			const pulls = await fetchJson<GithubPull[]>(
				`https://api.github.com/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=2`,
				{ headers: { 'X-GitHub-Api-Version': '2022-11-28' } },
			);
			return (pulls ?? []).slice(0, 1).map((pull) => ({
				id: `pr-${repo}-${pull.number}`,
				repo,
				number: pull.number,
				title: pull.title,
				href: pull.html_url,
				user: pull.user?.login ?? 'unknown',
				updatedAt: pull.updated_at,
				state: pull.state,
			}));
		}),
	);

	return batches
		.flat()
		.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
		.slice(0, 10);
}

export async function fetchPapers(limit = 12): Promise<FeedItem[]> {
	const xml = await fetchText(
		`https://export.arxiv.org/api/query?search_query=cat:cs.DC+OR+cat:cs.LG+OR+cat:cs.AI+OR+cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`,
	);
	if (!xml) return [];

	return parseAtomEntries(xml)
		.slice(0, limit)
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

			return {
				id: `paper-${href || index}`,
				title: clean(title, 140),
				href,
				source: 'arXiv',
				meta: [authors, date].filter(Boolean).join(' · '),
				summary: summary ? clean(summary, 200) : undefined,
			};
		});
}

function parseFeedNodes(xml: string) {
	const rss = parseRssItems(xml);
	return rss.length ? rss : parseAtomEntries(xml);
}

function statusIdFromHref(href: string, handle: string, index: number) {
	const match = href.match(/status\/(\d+)/i);
	return match ? `x-${match[1]}` : `x-${handle}-${index}`;
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
				const rawDesc = xmlTag(node, 'description') || rawTitle;
				const title = clean(rawTitle.replace(/^RT\s+@?\w+:\s*/i, ''), 160);
				const summary = clean(rawDesc.replace(/<[^>]+>/g, ' '), 220);
				const href =
					xmlTag(node, 'link') ||
					node.match(/<link[^>]+href="([^"]+)"/i)?.[1] ||
					`https://x.com/${handle}`;
				const normalizedHref = href.startsWith('http') ? href.replace('twitter.com', 'x.com') : `https://x.com/${handle}`;
				const ownPost = new RegExp(`x\\.com/${handle}/status/`, 'i').test(normalizedHref);
				if (!ownPost) return null;
				const date = (xmlTag(node, 'pubDate') || xmlTag(node, 'published') || '').slice(0, 25);
				const score = relevanceScore(`${title} ${summary}`, weight);
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
