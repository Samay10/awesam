import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Groq free-tier workhorse — stay on this model to avoid TPM blowups. */
export const TEXT_MODEL = process.env.TEXT_MODEL ?? 'llama-3.1-8b-instant';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const POLLINATIONS_IMAGE = 'https://image.pollinations.ai/prompt';

const IMAGE_GAP_MS = Number(process.env.IMAGE_GAP_MS ?? 16_000);
let lastImageAt = 0;
let lastTextAt = 0;
const TEXT_GAP_MS = Number(process.env.TEXT_GAP_MS ?? 1_200);

export function groqKey(): string | undefined {
	return process.env.GROQ_API_KEY || process.env.GROQ_KEY || undefined;
}

export function hasTextKey() {
	return Boolean(groqKey());
}

export function seedFromId(id: string) {
	const hex = createHash('sha1').update(id).digest('hex').slice(0, 8);
	return Number.parseInt(hex, 16) % 1_000_000;
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleText() {
	const wait = lastTextAt + TEXT_GAP_MS - Date.now();
	if (wait > 0) await sleep(wait);
	lastTextAt = Date.now();
}

export async function chatCompletion(
	messages: ChatMessage[],
	opts: { maxTokens?: number; temperature?: number; json?: boolean } = {},
): Promise<string> {
	const token = groqKey();
	if (!token) throw new Error('GROQ_API_KEY is missing');

	const wantJson = opts.json !== false;
	let lastError: Error | null = null;

	for (let attempt = 0; attempt < 4; attempt++) {
		await throttleText();
		const body: Record<string, unknown> = {
			model: TEXT_MODEL,
			messages,
			max_tokens: opts.maxTokens ?? 1600,
			temperature: opts.temperature ?? 0.4,
		};
		if (wantJson) body.response_format = { type: 'json_object' };

		const response = await fetch(GROQ_CHAT_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});

		if (response.status === 429) {
			const detail = await response.text().catch(() => '');
			const retry = /try again in ([\d.]+)s/i.exec(detail);
			const waitMs = retry ? Math.ceil(Number(retry[1]) * 1000) + 500 : 4_000 * (attempt + 1);
			lastError = new Error(`Groq 429 (${TEXT_MODEL}): ${detail.slice(0, 220)}`);
			await sleep(waitMs);
			continue;
		}

		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			lastError = new Error(`Groq ${response.status} (${TEXT_MODEL}): ${detail.slice(0, 280)}`);
			// JSON mode sometimes fails on small models — retry without it once.
			if (wantJson && /json/i.test(detail) && attempt >= 1) {
				opts = { ...opts, json: false };
			}
			await sleep(800 * (attempt + 1));
			continue;
		}

		const payload = (await response.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const text = payload.choices?.[0]?.message?.content?.trim();
		if (text) return text;
		lastError = new Error(`Groq returned an empty completion (${TEXT_MODEL})`);
	}

	throw lastError ?? new Error('Groq chat failed');
}

async function throttleImages() {
	const wait = lastImageAt + IMAGE_GAP_MS - Date.now();
	if (wait > 0) await sleep(wait);
	lastImageAt = Date.now();
}

export async function generateCoverPng(
	prompt: string,
	destPath: string,
	opts: { seed: number } = { seed: 1 },
): Promise<boolean> {
	const query = new URLSearchParams({
		model: process.env.IMAGE_MODEL ?? 'flux',
		width: '1024',
		height: '576',
		nologo: 'true',
		enhance: 'false',
		referrer: 'awesam',
		seed: String(opts.seed),
	});
	const encoded = encodeURIComponent(prompt.slice(0, 420));
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
