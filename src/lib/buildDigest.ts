import type { DigestBand, DigestCard, DigestSource } from '../data/digest';
import { digestBands as placeholderBands } from '../data/digest';
import { loadCatalog, type Story } from './catalog';
import type { FeedItem } from './feeds';

export const DIGEST_PLAN = [2, 2, 3, 3] as const;

export function sizeForBand(index: number): DigestCard['size'] {
	if (index === 0) return 'lead';
	if (index === 1) return 'deep';
	return 'dense';
}

export function readPath(id: string) {
	const base = import.meta.env.BASE_URL;
	return `${base}reads/${id}/`;
}

export function coverSrc(image: string | null | undefined) {
	if (!image) return null;
	const base = import.meta.env.BASE_URL;
	return `${base}${image.replace(/^\//, '')}`;
}

export function storyToCard(story: Story, size: DigestCard['size']): DigestCard {
	return {
		id: story.id,
		source: story.source,
		badge: story.badge,
		meta: story.meta,
		title: story.title,
		abstract: story.lede,
		href: readPath(story.id),
		originalHref: story.originalHref,
		image: coverSrc(story.image),
		cta: 'Read',
		stats: story.stats,
		size,
	};
}

/** Kept for fallback placeholder cards that still speak FeedItem. */
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
		badge: item.source,
		meta: '',
		title: item.title,
		abstract: item.summary ?? '',
		href: readPath(item.id),
		originalHref: item.href,
		cta: 'Read',
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

export function storiesToBands(stories: Story[], plan: readonly number[] = DIGEST_PLAN): DigestBand[] {
	const cards = chunkByPlan(stories, plan).flatMap((bandStories, bandIndex) =>
		bandStories.map((story) => storyToCard(story, sizeForBand(bandIndex))),
	);
	return cardsToBands(cards, plan);
}

export async function buildLiveDigestBands(): Promise<DigestBand[]> {
	const catalog = await loadCatalog();
	if (catalog.digest.length === 0) return placeholderBands;
	return storiesToBands(catalog.digest);
}
