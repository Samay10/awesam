// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
	site: 'https://samay10.github.io',
	base: '/awesam/',
	vite: {
		plugins: [tailwindcss()],
	},
});
