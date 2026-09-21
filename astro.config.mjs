// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import { loadDotenv, runEnrichment } from './src/lib/enrich.ts';

loadDotenv();

function enrichStories() {
	return {
		name: 'awesam-enrich',
		hooks: {
			'astro:config:setup': async ({ command }) => {
				if (command === 'build' || command === 'dev') {
					try {
						await runEnrichment();
					} catch (error) {
						console.warn('[enrich] pipeline failed; building with any cached catalog', error);
					}
				}
			},
		},
	};
}

// https://astro.build/config
export default defineConfig({
	site: 'https://samay10.github.io',
	base: '/awesam/',
	integrations: [enrichStories()],
	vite: {
		plugins: [tailwindcss()],
	},
});
