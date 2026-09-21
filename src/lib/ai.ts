/** Strong free Groq model for prose. Fallbacks if one is missing/rate-limited. */
export const TEXT_MODELS = (
	process.env.TEXT_MODELS ??
	'llama-3.3-70b-versatile,openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3-32b'
)
	.split(',')
	.map((value) => value.trim())
	.filter(Boolean);

export const TEXT_MODEL = TEXT_MODELS[0] ?? 'llama-3.3-70b-versatile';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

let lastTextAt = 0;
const TEXT_GAP_MS = Number(process.env.TEXT_GAP_MS ?? 1_500);
let resolvedModels: string[] | null = null;

export function groqKey(): string | undefined {
	return process.env.GROQ_API_KEY || process.env.GROQ_KEY || undefined;
}

export function hasTextKey() {
	return Boolean(groqKey());
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

async function availableModels(token: string): Promise<string[]> {
	if (resolvedModels) return resolvedModels;
	try {
		const response = await fetch(GROQ_MODELS_URL, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok) {
			resolvedModels = TEXT_MODELS;
			return resolvedModels;
		}
		const payload = (await response.json()) as { data?: { id?: string }[] };
		const ids = new Set((payload.data ?? []).map((row) => row.id).filter(Boolean) as string[]);
		const preferred = TEXT_MODELS.filter((id) => ids.has(id));
		resolvedModels = preferred.length ? preferred : TEXT_MODELS;
		console.log(`[enrich] groq models available: ${resolvedModels.join(', ')}`);
		return resolvedModels;
	} catch {
		resolvedModels = TEXT_MODELS;
		return resolvedModels;
	}
}

export async function chatCompletion(
	messages: ChatMessage[],
	opts: { maxTokens?: number; temperature?: number; json?: boolean } = {},
): Promise<string> {
	const token = groqKey();
	if (!token) throw new Error('GROQ_API_KEY is missing');

	const models = await availableModels(token);
	const wantJson = opts.json !== false;
	let lastError: Error | null = null;

	for (const model of models) {
		for (let attempt = 0; attempt < 3; attempt++) {
			await throttleText();
			const useJson = wantJson && attempt === 0;
			const body: Record<string, unknown> = {
				model,
				messages,
				max_tokens: opts.maxTokens ?? 1800,
				temperature: opts.temperature ?? 0.55,
			};
			if (useJson) body.response_format = { type: 'json_object' };

			const response = await fetch(GROQ_CHAT_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			});

			if (response.status === 404) {
				const detail = await response.text().catch(() => '');
				lastError = new Error(`Groq 404 (${model}): ${detail.slice(0, 200)}`);
				break; // try next model
			}

			if (response.status === 429) {
				const detail = await response.text().catch(() => '');
				const retry = /try again in ([\d.]+)s/i.exec(detail);
				const waitMs = retry ? Math.ceil(Number(retry[1]) * 1000) + 750 : 5_000 * (attempt + 1);
				lastError = new Error(`Groq 429 (${model}): ${detail.slice(0, 220)}`);
				await sleep(waitMs);
				continue;
			}

			if (!response.ok) {
				const detail = await response.text().catch(() => '');
				lastError = new Error(`Groq ${response.status} (${model}): ${detail.slice(0, 280)}`);
				if (/json/i.test(detail)) {
					await sleep(600);
					continue; // retry without json mode
				}
				await sleep(900 * (attempt + 1));
				continue;
			}

			const payload = (await response.json()) as {
				choices?: { message?: { content?: string } }[];
			};
			const text = payload.choices?.[0]?.message?.content?.trim();
			if (text) {
				if (model !== TEXT_MODEL) console.log(`[enrich] used model ${model}`);
				return text;
			}
			lastError = new Error(`Groq returned an empty completion (${model})`);
		}
	}

	throw lastError ?? new Error('Groq chat failed');
}
