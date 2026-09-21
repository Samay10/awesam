export type DigestSource = 'hn' | 'x' | 'github' | 'papers' | 'articles';

export type DigestCard = {
	id: string;
	source: DigestSource;
	badge: string;
	meta: string;
	title: string;
	abstract: string;
	href: string;
	cta: string;
	stats: string[];
	diagram?: {
		label: string;
		accent: string;
		cells: { title: string; subtitle: string }[];
		footer: string;
	};
	metricBar?: { left: string; right: string; width: number };
	size: 'lead' | 'deep' | 'dense';
};

export type DigestBand = {
	id: string;
	label: string;
	title: string;
	aside: string;
	cards: DigestCard[];
};

/** Placeholder catalog matching the Stitch layout. Replace with live APIs next. */
export const digestBands: DigestBand[] = [
	{
		id: '01',
		label: 'Band 01',
		title: 'Top Breakthroughs',
		aside: 'Distributed Fabrics & Multi-Agent Logic',
		cards: [
			{
				id: 'nvme-rdma',
				source: 'hn',
				badge: 'HN · Top Story',
				meta: '5 MIN READ · 10:45 UTC',
				title: 'Benchmarking Modern Distributed File Systems: NVMe-oF vs. RDMA Object Fabrics',
				abstract:
					'An empirical analysis of tail latencies across RoCEv2, InfiniBand, and pooled TCP namespaces at 400Gbps. We observe non-linear backoff degradation during asynchronous write spikes and propose a zero-copy slab buffer technique that drops p99 tail latency from 840μs to 82μs.',
				href: 'https://news.ycombinator.com',
				cta: 'Deep Dive',
				stats: ['842 pts', '218 comments'],
				size: 'lead',
				diagram: {
					label: 'ZERO-COPY FABRIC TOPOLOGY',
					accent: '400 GbE RoCEv2',
					cells: [
						{ title: 'Host Slab', subtitle: 'Client App' },
						{ title: 'RDMA NIC', subtitle: 'Kernel Bypass' },
						{ title: 'Target NVMe', subtitle: 'PCIe Gen5' },
					],
					footer: 'Data Path: Zero CPU Intervention · Monolithic DMA Transfer Loop',
				},
			},
			{
				id: 'reasoning-agents',
				source: 'x',
				badge: 'X / AI Research',
				meta: '4 MIN READ · 11:20 UTC',
				title: 'Reasoning Models & Autonomous Coding Agents at Scale: The Reality of Verification',
				abstract:
					'Exploring why raw chain-of-thought token output hits a strict reliability ceiling without hermetic compilation sandboxes. New findings verify that automated AST fuzzing and runtime formal invariants improve generation accuracy by 41% across production repositories.',
				href: 'https://x.com',
				cta: 'Deep Dive',
				stats: ['148 reposts', '54 quotes'],
				size: 'lead',
				diagram: {
					label: 'VERIFICATION PIPELINE',
					accent: 'Closed Feedback Loop',
					cells: [
						{ title: 'Generator', subtitle: 'CoT Engine' },
						{ title: 'Sandbox', subtitle: 'Type & Fuzz' },
						{ title: 'AST Delta', subtitle: 'Validated PR' },
					],
					footer: 'Latency: 1.2s Per Verification Step · 99.8% Deterministic Replay',
				},
			},
		],
	},
	{
		id: '02',
		label: 'Band 02',
		title: 'Systems & Inference',
		aside: 'Architectural Optimizations',
		cards: [
			{
				id: 'kv-cache',
				source: 'papers',
				badge: 'ArXiv:2410.1189',
				meta: '4 MIN READ · CS.LG',
				title: 'Next-Gen LLM Inference: Dynamic Key-Value Cache Eviction via Attention Head Salience',
				abstract:
					'Pre-allocating uniform KV slots across layers incurs severe memory fragmentation. This publication demonstrates an adaptive head-pruning scheduler that tracks entropy across multi-layer attention heads, releasing up to 64% of static VRAM footprint without loss on needle-in-a-haystack tasks.',
				href: 'https://arxiv.org',
				cta: 'View Preprint',
				stats: ['18 pages · PyTorch 2.5 + CUDA 12.4', '3.4x TPUT GAIN'],
				size: 'deep',
			},
			{
				id: 'postgres-simd',
				source: 'github',
				badge: 'GitHub Engine',
				meta: '3 MIN READ · C++ / RUST',
				title: 'PostgreSQL Under the Hood: SIMD-Vectorized Execution in Modern Analytic Extensions',
				abstract:
					'Breaking down row-at-a-time tuple iterations using AVX-512 and ARM NEON intrinsics. By repackaging PostgreSQL scan nodes into contiguous batch buffers, analytic aggregations approach Arrow memory speeds while preserving standard ACID transaction semantics.',
				href: 'https://github.com',
				cta: 'View Repository',
				stats: ['postgres-vec/kernel · Apache 2.0', '★ 6.4k stars'],
				size: 'deep',
			},
		],
	},
	{
		id: '03',
		label: 'Band 03',
		title: 'Engineering & Tooling',
		aside: 'Kernels, Teams, Decoders',
		cards: [
			{
				id: 'fastllama',
				source: 'github',
				badge: 'GitHub',
				meta: 'v0.9.4',
				title: 'FastLlama-Kernel: Sub-millisecond Triton Kernels for Fused RoPE & SwiGLU',
				abstract:
					'A pure OpenAI Triton implementation eliminating global memory roundtrips between positional rotary embeddings and gate activations on NVIDIA Hopper architectures.',
				href: 'https://github.com',
				cta: 'Open',
				stats: ['★ 8,410', '0.42ms Latency'],
				size: 'dense',
				metricBar: { left: '★ 8,410', right: '0.42ms Latency', width: 85 },
			},
			{
				id: 'death-spiral',
				source: 'hn',
				badge: 'HN Reflection',
				meta: '4 MIN READ',
				title: 'The Senior Engineer Death Spiral and Organizational Architecture',
				abstract:
					'Why high-performing senior engineers slowly transition into triage filters for organizational fragmentation, and structural remedies to shield technical depth from meeting sprawl.',
				href: 'https://news.ycombinator.com',
				cta: 'Read Essay →',
				stats: ['1,240 pts', '412 comments'],
				size: 'dense',
			},
			{
				id: 'spec-decoding',
				source: 'papers',
				badge: 'ArXiv:2410.0984',
				meta: 'ICML 2026',
				title: 'Diffusion Draft Models: 10x Latency Reduction for Speculative Decoding',
				abstract:
					'Replacing autoregressive speculative drafters with continuous-time diffusion trajectories. Achieves acceptance rates of >88% on complex code synthesis benchmarks.',
				href: 'https://arxiv.org',
				cta: 'arXiv.org ↗',
				stats: ['22 pages', '88.4% Acceptance'],
				size: 'dense',
			},
		],
	},
	{
		id: '04',
		label: 'Band 04',
		title: 'Emerging Signals',
		aside: 'Benchmarks, Formal Proofs, MicroVMs',
		cards: [
			{
				id: 'swe-bench',
				source: 'x',
				badge: 'X / Thread',
				meta: 'RESEARCH NOTE',
				title: 'Evaluating Agentic Workflows on SWE-bench: Where Code Agents Falter',
				abstract:
					'A comprehensive breakdown of failure modes in 10 leading developer agents: context degradation during multi-file edits and hallucinated CLI arguments dominate 78% of failed patches.',
				href: 'https://x.com',
				cta: 'Thread ↗',
				stats: ['42.1k views', 'Benchmark Delta'],
				size: 'dense',
			},
			{
				id: 'tla-queues',
				source: 'hn',
				badge: 'HN Systems',
				meta: 'TLA+ PROOFS',
				title: 'Formal Verification of Concurrent Lock-Free Ring Queues with TLA+',
				abstract:
					'Uncovering subtle ABA memory hazards in standard single-producer multi-consumer rings under ARM memory consistency models using automated model checkers.',
				href: 'https://news.ycombinator.com',
				cta: 'Spec Sheet ↗',
				stats: ['492 pts', '88 comments'],
				size: 'dense',
			},
			{
				id: 'microvm',
				source: 'github',
				badge: 'GitHub Craft',
				meta: 'RUST / KVM',
				title: 'MicroVM Orchestration: Booting Linux in 18 Milliseconds with Rust',
				abstract:
					'A bare-metal hypervisor wrapper utilizing direct KVM ioctls and uncompressed kernel snapshots to instantiate full isolation sandboxes in sub-frame durations.',
				href: 'https://github.com',
				cta: 'Repository ↗',
				stats: ['★ 4.9k', '18ms Cold Boot'],
				size: 'dense',
			},
		],
	},
];

export const digestSynthesis = [
	{
		title: 'Convergence of Fabrics',
		body: 'Storage and GPU interconnects are collapsing into shared RDMA namespaces. Expect scheduling systems to treat NVMe and HBM as peers in the same placement graph.',
	},
	{
		title: 'Rigorous Verification',
		body: 'Agentic coding only scales when hermetic sandboxes and formal checks sit in the loop. Raw generation without replayable verification remains a liability.',
	},
	{
		title: 'Kernel-Level Craft',
		body: 'From Triton fused ops to MicroVM cold boots, the winning edge is still low-level systems work that shaves milliseconds and memory without abandoning correctness.',
	},
];

export function countBySource(bands: DigestBand[]) {
	const cards = bands.flatMap((band) => band.cards);
	return {
		all: cards.length,
		hn: cards.filter((c) => c.source === 'hn').length,
		x: cards.filter((c) => c.source === 'x').length,
		github: cards.filter((c) => c.source === 'github').length,
		papers: cards.filter((c) => c.source === 'papers').length,
	};
}
