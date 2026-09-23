const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	hellip: '…',
	mdash: '—',
	ndash: '–',
	rsquo: '’',
	lsquo: '‘',
	rdquo: '”',
	ldquo: '“',
	bull: '·',
};

function safeChar(code: number) {
	if (!Number.isFinite(code) || code < 32 || code === 127) return ' ';
	try {
		return String.fromCodePoint(code);
	} catch {
		return ' ';
	}
}

function decodeEntities(text: string) {
	let prev = '';
	let cur = text;
	for (let i = 0; i < 4 && cur !== prev; i++) {
		prev = cur;
		cur = cur
			.replace(new RegExp('&' + '#x([0-9a-f]+);?', 'gi'), (_, hex) => safeChar(parseInt(hex, 16)))
			.replace(new RegExp('&' + '#(\\d+);?', 'g'), (_, dec) => safeChar(parseInt(dec, 10)))
			.replace(/&([a-z]+);/gi, (match, name: string) => NAMED[name.toLowerCase()] ?? match);
	}
	// Leftovers from a previous pass that ate the '#' in numeric apostrophe entities.
	return cur.replace(/&39;?/g, "'").replace(/&quot;?/gi, '"').replace(/&amp;?/gi, '&');
}

/** Feed HTML / XML → plain prose. Never leaves tags, comments, or entities. */
export function toPlainText(text: string) {
	let value = decodeEntities(String(text ?? '').replace(/<!\[CDATA\[|\]\]>/g, ''));
	value = value.replace(/<!--[\s\S]*?-->/g, ' ');
	value = value.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
	value = value.replace(/<br\s*\/?>/gi, '\n');
	value = value.replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n\n');
	value = value.replace(/<li[^>]*>/gi, '• ');
	value = value.replace(/<[^>]+>/g, ' ');
	value = decodeEntities(value);
	value = value.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
	value = value
		.replace(/[ \t]*\n[ \t]*/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
	return value;
}

export function clip(text: string, max: number) {
	const next = toPlainText(text);
	if (next.length <= max) return next;
	const cut = next.slice(0, max - 1);
	const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
	return `${(stop > max * 0.6 ? cut.slice(0, stop) : cut).trim()}…`;
}

/**
 * Card / list headline that fits without a trailing ellipsis.
 * Prefers cutting on punctuation or a word boundary.
 */
export function fitHeadline(text: string, max = 72) {
	const next = toPlainText(text)
		.replace(/[.…]+$/u, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (next.length <= max) return next;

	const window = next.slice(0, max + 1);
	const marks = [': ', ' — ', ' – ', ' - ', '. ', '? ', '! ', '; ', ', '];
	let breakAt = -1;
	for (const mark of marks) {
		const at = window.lastIndexOf(mark);
		if (at > max * 0.4) breakAt = Math.max(breakAt, at);
	}
	if (breakAt < 0) breakAt = window.lastIndexOf(' ');
	if (breakAt < max * 0.35) breakAt = max;

	return window
		.slice(0, breakAt)
		.replace(/[,:;.\-–—/?!]+$/u, '')
		.trim();
}
