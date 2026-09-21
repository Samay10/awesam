import { loadDotenv, runEnrichment } from './enrich';

loadDotenv();
await runEnrichment();
