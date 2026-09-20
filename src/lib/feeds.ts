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

const X_HANDLES = [
	{ handle: 'karpathy', label: 'Andrej Karpathy' },
	{ handle: 'sama', label: 'Sam Altman' },
	{ handle: 'ylecun', label: 'Yann LeCun' },
	{ handle: 'OpenAI', label: 'OpenAI' },
	{ handle: 'ycombinator', label: 'Y Combinator' },
	{ handle: 'github', label: 'GitHub' },
] as const;

function isoDate(daysAgo: number) {
	const date = new Date();
	date.setUTCDate(date.getUTCDate() - daysAgo);
	return date.toISOString().slice(0, 10);
}

function clean(text: string, max = 220) {
	const next = text.replace(/\s+/g, ' ').trim();
	return next.length > max ? `${next.slice(0, max - 1)}…` : next;
}

function matchesAny(text: string, words: string[]) {
	const hay = text.toLowerCase();
	return words.some((word) => hay.includes(word));
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
};

export async function fetchHackerNews(limit = 12): Promise<FeedItem[]> {
	const ids = (await fetchJson<number[]>('https://hacker-news.firebaseio.com/v0/topstories.json')) ?? [];
	const stories = (
		await Promise.all(
			ids.slice(0, 40).map((id) => fetchJson<HnStory>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)),
		)
	).filter((story): story is HnStory => Boolean(story?.title && story.type === 'story'));

	return stories
		.map((story) => {
			const title = story.title ?? '';
			const relevant = matchesAny(title, HN_KEYWORDS);
			return {
				id: `hn-${story.id}`,
				title,
				href: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
				source: 'Hacker News',
				meta: `${story.score ?? 0} pts · ${story.by ?? 'anon'} · ${story.descendants ?? 0} comments`,
				score: (story.score ?? 0) + (relevant ? 80 : 0),
			};
		})
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
		.slice(0, limit);
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

	return (payload?.items ?? []).slice(0, limit).map((repo) => ({
		id: `gh-${repo.id}`,
		title: repo.full_name,
		href: repo.html_url,
		source: 'GitHub',
		meta: `${repo.stargazers_count.toLocaleString()} ★ · ${repo.language ?? 'polyglot'}`,
		summary: repo.description ? clean(repo.description, 160) : undefined,
	}));
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

async function fetchHandleFeed(handle: string, label: string): Promise<FeedItem[]> {
	const urls = [
		`https://rsshub.app/twitter/user/${handle}`,
		`https://nitter.privacydev.net/${handle}/rss`,
		`https://nitter.net/${handle}/rss`,
	];

	for (const url of urls) {
		const xml = await fetchText(url);
		if (!xml || (!xml.includes('<item') && !xml.includes('<entry'))) continue;
		return parseFeedNodes(xml)
			.slice(0, 4)
			.map((node, index) => {
				const title = xmlTag(node, 'title') || xmlTag(node, 'description');
				const href =
					xmlTag(node, 'link') ||
					node.match(/<link[^>]+href="([^"]+)"/i)?.[1] ||
					`https://x.com/${handle}`;
				const date = (xmlTag(node, 'pubDate') || xmlTag(node, 'published') || '').slice(0, 16);
				return {
					id: `x-${handle}-${index}`,
					title: clean(title.replace(/^RT\s+/, ''), 160),
					href: href.startsWith('http') ? href : `https://x.com/${handle}`,
					source: `@${handle}`,
					meta: [label, date].filter(Boolean).join(' · '),
				};
			})
			.filter((item) => item.title);
	}

	return [];
}

export async function fetchXTimeline(limit = 12): Promise<FeedItem[]> {
	const batches = await Promise.all(X_HANDLES.map(({ handle, label }) => fetchHandleFeed(handle, label)));
	const live = batches.flat().filter((item) => item.title && item.href);

	if (live.length > 0) {
		return live.slice(0, limit);
	}

	// X has no public list API — curated listen list with deep links so the section stays useful.
	return X_HANDLES.map(({ handle, label }, index) => ({
		id: `x-listen-${handle}`,
		title: `Follow ${label} on X`,
		href: `https://x.com/${handle}`,
		source: `@${handle}`,
		meta: 'Curated listen list',
		summary: 'Live X syndication was quiet — open the profile for the latest posts.',
		score: X_HANDLES.length - index,
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
