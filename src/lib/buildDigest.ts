import type { DigestBand, DigestCard, DigestSource } from '../data/digest';
import { digestBands as placeholderBands } from '../data/digest';
import { fetchGithubRepos, fetchHackerNews, fetchPapers, fetchXTimeline, type FeedItem } from './feeds';

export const DIGEST_PLAN = [2, 2, 3, 3] as const;

const CTA: Record<DigestSource, string> = {
	hn: 'Deep Dive',
	x: 'Open',
	github: 'View Repository',
	papers: 'View Preprint',
	articles: 'Read',
};

const BADGE: Record<DigestSource, string> = {
	hn: 'HN · Best',
	x: 'X / Lab',
	github: 'GitHub',
	papers: 'ArXiv',
	articles: 'Article',
};

export function sizeForBand(index: number): DigestCard['size'] {
	if (index === 0) return 'lead';
	if (index === 1) return 'deep';
	return 'dense';
}

export function feedToCard(item: FeedItem, source: DigestSource, size: DigestCard['size']): DigestCard {
	const stats = item.meta
		? item.meta
				.split('·')
				.map((part) => part.trim())
				.filter(Boolean)
		: [];

	return {
		id: item.id,
		source,
		badge: source === 'papers' || source === 'x' ? item.source : BADGE[source],
		meta: '',
		title: item.title,
		abstract: item.summary ?? '',
		href: item.href,
		cta: source === 'papers' && !/arxiv/i.test(item.source) ? 'View Paper' : CTA[source],
		stats,
		size,
	};
}

export function chunkByPlan<T>(items: T[], plan: readonly number[] = DIGEST_PLAN): T[][] {
	const bands: T[][] = [];
	let cursor = 0;
	for (let i = 0; i < plan.length && cursor < items.length; i++) {
		bands.push(items.slice(cursor, cursor + plan[i]));
		cursor += plan[i];
	}
	if (cursor < items.length) bands.push(items.slice(cursor));
	return bands;
}

export function cardsToBands(cards: DigestCard[], plan: readonly number[] = DIGEST_PLAN): DigestBand[] {
	return chunkByPlan(cards, plan).map((bandCards, index) => ({
		id: String(index + 1).padStart(2, '0'),
		label: '',
		title: '',
		aside: '',
		cards: bandCards.map((card) => ({
			...card,
			size: sizeForBand(index),
		})),
	}));
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

/** Mix live feeds into the 2·2·3·3 digest grid. Pads with HN best if a source is quiet. */
export async function buildLiveDigestBands(): Promise<DigestBand[]> {
	const [hn, github, papers, x] = await Promise.all([
		fetchHackerNews(12),
		fetchGithubRepos(6),
		fetchPapers(6),
		fetchXTimeline(6),
	]);

	const picks: Sourced[] = [];
	take(hn, 'hn', 4, picks);
	take(github, 'github', 2, picks);
	take(papers, 'papers', 2, picks);
	take(x, 'x', 2, picks);
	take(hn, 'hn', 10 - picks.length, picks);

	if (picks.length === 0) return placeholderBands;

	const cards = picks.map(({ item, source }, index) => {
		const bandIndex = index < 2 ? 0 : index < 4 ? 1 : index < 7 ? 2 : 3;
		return feedToCard(item, source, sizeForBand(bandIndex));
	});

	return cardsToBands(cards);
}
