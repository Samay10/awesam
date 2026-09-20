export type FeedId = 'hn' | 'github' | 'papers' | 'field';

export type FeedItem = {
	id: string;
	title: string;
	href: string;
	source: string;
	meta: string;
	summary?: string;
	score?: number;
};

export type FeedSection = {
	id: FeedId;
	label: string;
	kicker: string;
	blurb: string;
	items: FeedItem[];
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

const FIELD_KEYWORDS = [
	'distributed',
	'system',
	'llm',
	'inference',
	'agent',
	'latency',
	'consistency',
	'consensus',
	'compiler',
	'database',
];

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
				'User-Agent': 'AweSam-Wire/1.0 (https://samay10.github.io/awesam/)',
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
				Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml',
				'User-Agent': 'AweSam-Wire/1.0 (https://samay10.github.io/awesam/)',
			},
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

async function fetchHackerNews(): Promise<FeedItem[]> {
	const ids = (await fetchJson<number[]>('https://hacker-news.firebaseio.com/v0/topstories.json')) ?? [];
	const stories = (
		await Promise.all(
			ids.slice(0, 36).map((id) => fetchJson<HnStory>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)),
		)
	).filter((story): story is HnStory => Boolean(story?.title && story.type === 'story'));

	const ranked = stories
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
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

	return ranked.slice(0, 8);
}

type GithubRepo = {
	id: number;
	full_name: string;
	html_url: string;
	description: string | null;
	stargazers_count: number;
	language: string | null;
	owner?: { login?: string };
};

async function fetchGithubRepos(): Promise<FeedItem[]> {
	const since = isoDate(10);
	const query = encodeURIComponent(`created:>${since} stars:>20`);
	const payload = await fetchJson<{ items?: GithubRepo[] }>(
		`https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=8`,
		{ headers: { 'X-GitHub-Api-Version': '2022-11-28' } },
	);

	return (payload?.items ?? []).slice(0, 8).map((repo) => ({
		id: `gh-${repo.id}`,
		title: repo.full_name,
		href: repo.html_url,
		source: 'GitHub',
		meta: `${repo.stargazers_count.toLocaleString()} ★ · ${repo.language ?? 'polyglot'}`,
		summary: repo.description ? clean(repo.description, 160) : undefined,
	}));
}

async function fetchPapers(): Promise<FeedItem[]> {
	const xml = await fetchText(
		'https://export.arxiv.org/api/query?search_query=cat:cs.DC+OR+cat:cs.LG+OR+cat:cs.AI+OR+cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=10',
	);
	if (!xml) return [];

	return parseAtomEntries(xml)
		.slice(0, 8)
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

type RssSource = { name: string; url: string };

async function fetchFieldNotes(): Promise<FeedItem[]> {
	const sources: RssSource[] = [
		{ name: 'Berkeley AI Research', url: 'https://bair.berkeley.edu/blog/feed.xml' },
		{ name: 'Google Research', url: 'https://research.google/blog/rss/' },
		{ name: 'The Morning Paper', url: 'https://blog.acolyer.org/feed/' },
		{ name: 'AWS Architecture', url: 'https://aws.amazon.com/blogs/architecture/feed/' },
	];

	const feeds = await Promise.all(
		sources.map(async (source) => {
			const xml = await fetchText(source.url);
			if (!xml) return [] as FeedItem[];
			const nodes = parseRssItems(xml).length ? parseRssItems(xml) : parseAtomEntries(xml);
			return nodes.slice(0, 6).map((node, index) => {
				const title = xmlTag(node, 'title');
				const href = xmlTag(node, 'link') || node.match(/<link[^>]+href="([^"]+)"/i)?.[1] || '';
				const summary = xmlTag(node, 'description') || xmlTag(node, 'summary');
				const date = (xmlTag(node, 'pubDate') || xmlTag(node, 'published') || xmlTag(node, 'updated')).slice(
					0,
					16,
				);
				return {
					id: `field-${source.name}-${index}`,
					title: clean(title, 140),
					href,
					source: source.name,
					meta: date,
					summary: summary ? clean(summary, 180) : undefined,
					score: matchesAny(`${title} ${summary}`, FIELD_KEYWORDS) ? 2 : 1,
				};
			});
		}),
	);

	return feeds
		.flat()
		.filter((item) => item.title && item.href)
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
		.slice(0, 8)
		.map(({ score: _score, ...item }) => item);
}

export async function loadWire(): Promise<FeedSection[]> {
	const [hn, github, papers, field] = await Promise.all([
		fetchHackerNews(),
		fetchGithubRepos(),
		fetchPapers(),
		fetchFieldNotes(),
	]);

	return [
		{
			id: 'hn',
			label: 'Hacker News',
			kicker: 'YC floor',
			blurb: 'Highest-signal HN stories, tilted toward systems, AI, and things worth opening twice.',
			items: hn,
		},
		{
			id: 'github',
			label: 'GitHub',
			kicker: 'Rising repos',
			blurb: 'New repositories gaining stars this week — the ones people are actually cloning.',
			items: github,
		},
		{
			id: 'papers',
			label: 'Papers',
			kicker: 'arXiv press',
			blurb: 'Fresh CS papers from arXiv in distributed systems, learning, and language.',
			items: papers,
		},
		{
			id: 'field',
			label: 'Field notes',
			kicker: 'Systems & AI',
			blurb: 'Lab blogs and architecture notes from the open web — BAIR, Google Research, The Morning Paper, AWS.',
			items: field,
		},
	];
}
