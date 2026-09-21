import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Groq free-tier workhorse — 14.4k requests/day, no card. */
export const TEXT_MODEL = process.env.TEXT_MODEL ?? 'llama-3.1-8b-instant';
const TEXT_FALLBACKS = (process.env.TEXT_FALLBACKS ?? 'llama-3.1-8b-instant,openai/gpt-oss-20b')
	.split(',')
	.map((value) => value.trim())
	.filter(Boolean);

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const POLLINATIONS_IMAGE = 'https://image.pollinations.ai/prompt';

const IMAGE_GAP_MS = Number(process.env.IMAGE_GAP_MS ?? 16_000);
let lastImageAt = 0;

export function groqKey(): string | undefined {
	return process.env.GROQ_API_KEY || process.env.GROQ_KEY || undefined;
}

export function hasTextKey() {
	return Boolean(groqKey());
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function chatCompletion(
	messages: ChatMessage[],
	opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
	const token = groqKey();
	if (!token) throw new Error('GROQ_API_KEY is missing');

	const models = [...new Set([TEXT_MODEL, ...TEXT_FALLBACKS])];
	let lastError: Error | null = null;

	for (const model of models) {
		const response = await fetch(GROQ_CHAT_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model,
				messages,
				max_tokens: opts.maxTokens ?? 1100,
				temperature: opts.temperature ?? 0.35,
				response_format: { type: 'json_object' },
			}),
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			lastError = new Error(`Groq ${response.status} (${model}): ${detail.slice(0, 280)}`);
			continue;
		}

		const payload = (await response.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const text = payload.choices?.[0]?.message?.content?.trim();
		if (text) return text;
		lastError = new Error(`Groq returned an empty completion (${model})`);
	}

	throw lastError ?? new Error('Groq chat failed');
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleImages() {
	const wait = lastImageAt + IMAGE_GAP_MS - Date.now();
	if (wait > 0) await sleep(wait);
	lastImageAt = Date.now();
}

export async function generateCoverPng(prompt: string, destPath: string): Promise<boolean> {
	const query = new URLSearchParams({
		model: process.env.IMAGE_MODEL ?? 'flux',
		width: '1024',
		height: '576',
		nologo: 'true',
		enhance: 'false',
		referrer: 'awesam',
	});
	const encoded = encodeURIComponent(prompt.slice(0, 450));
	const pollinationsKey = process.env.POLLINATIONS_KEY;

	const urls = pollinationsKey
		? [`https://gen.pollinations.ai/image/${encoded}?${query.toString()}`]
		: [`${POLLINATIONS_IMAGE}/${encoded}?${query.toString()}`];

	for (const url of urls) {
		await throttleImages();
		const headers: Record<string, string> = {};
		if (pollinationsKey) headers.Authorization = `Bearer ${pollinationsKey}`;

		const response = await fetch(url, { headers, redirect: 'follow' });
		if (response.status === 402 || response.status === 429) {
			await sleep(IMAGE_GAP_MS);
			continue;
		}
		if (!response.ok) continue;

		const type = response.headers.get('content-type') ?? '';
		if (!type.startsWith('image/')) continue;

		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength < 800) continue;

		await mkdir(path.dirname(destPath), { recursive: true });
		await writeFile(destPath, bytes);
		return true;
	}

	return false;
}
