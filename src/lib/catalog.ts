import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DigestSource } from '../data/digest';

export type Story = {
	id: string;
	source: DigestSource;
	badge: string;
	title: string;
	lede: string;
	whyRead: string;
	paragraphs: string[];
	takeaway?: string;
	blurb?: string;
	originalHref: string;
	image: string | null;
	stats: string[];
	meta: string;
	sourceLabel: string;
};

export type StoryCatalog = {
	generatedAt: string;
	digest: Story[];
	hn: Story[];
	x: Story[];
	github: Story[];
	papers: Story[];
	press: Story[];
	reddit: Story[];
};

export const CATALOG_PATH = path.join(process.cwd(), 'src/data/generated/stories.json');

let cached: StoryCatalog | null = null;

const empty = (): StoryCatalog => ({
	generatedAt: '',
	digest: [],
	hn: [],
	x: [],
	github: [],
	papers: [],
	press: [],
	reddit: [],
});

export async function loadCatalog(): Promise<StoryCatalog> {
	if (cached) return cached;
	try {
		const raw = await readFile(CATALOG_PATH, 'utf8');
		const parsed = JSON.parse(raw) as StoryCatalog;
		cached = {
			...empty(),
			...parsed,
			press: parsed.press ?? [],
			reddit: parsed.reddit ?? [],
		};
		return cached;
	} catch {
		return empty();
	}
}

export function allStories(catalog: StoryCatalog): Story[] {
	const seen = new Set<string>();
	const rows: Story[] = [];
	for (const story of [
		...catalog.digest,
		...catalog.hn,
		...catalog.x,
		...catalog.github,
		...catalog.papers,
		...catalog.press,
		...catalog.reddit,
	]) {
		if (seen.has(story.id)) continue;
		seen.add(story.id);
		rows.push(story);
	}
	return rows;
}

export function storySlug(id: string) {
	return id
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 96);
}
