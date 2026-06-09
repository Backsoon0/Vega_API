# DeepResearch Agent - Architecture Analysis & Upgrade Plan

## Current State Assessment

### What We Have
- A scaffolded Cloudflare Workers template (`src/index.js`)
- Standard `fetch` handler pattern (NOT using agents-sdk Agent class)
- Vertex AI Gemini as the LLM backend
- Basic wrangler.jsonc configuration (no Durable Objects bindings yet)

### What's Missing for a Production DeepResearch Agent
1. **agents-sdk integration** — Not using Agent class, state management, or hibernation
2. **Memory/Persistence** — No long-term memory between research sessions
3. **Token management** — No chunking or progressive summarization for large research topics
4. **Streaming** — No SSE/WebSocket for real-time research progress
5. **Multi-step research pipeline** — Single-turn, no iterative deep research
6. **Error handling & retries** — No robust error recovery
7. **Prompt engineering** — Missing structured prompts per research phase

---

## Target Architecture

```
User Request → HTTP /research
    ↓
DeepResearchAgent.onRequest()
    ↓
Phase 1: Topic Analysis & Decomposition
    ↓
Phase 2: Parallel Web Search (fan-out)
    ↓
Phase 3: Source Fetching & Extraction
    ↓
Phase 4: Cross-referencing & Verification
    ↓
Phase 5: Report Synthesis
    ↓
Phase 6: Final Polish & Citation Formatting
    ↓
SSE Stream → User receives report progressively
```

---

## Key agents-sdk Features to Leverage

### 1. Agent Class (Stateful Durable Object)
- Extend `Agent` from `agents-sdk`
- Use `this.state` for persistent research state across hibernation cycles
- Use `this.sqlite` (via Durable Objects SQLite) for large research artifact storage
- Use `this.schedule()` for long-running research tasks

### 2. AIChatAgent Pattern
- Extend `AIChatAgent` for built-in message history management
- `this.messages` — auto-persisted conversation array
- `onChatMessage(onFinish)` — structured streaming response handler
- Use `createDataStreamResponse` with `streamText` for SSE output

### 3. State Management
- `this.setState()` — persist research phase, findings, intermediate results
- `onStateUpdate(state, source)` — sync state across reconnections
- Durable Object hibernation — agent sleeps when idle, wakes on request

### 4. Scheduling
- `this.schedule(10, "checkProgress")` — periodic progress checks
- `this.schedule("0 */6 * * *", "dailyDigest")` — cron-based research digests

### 5. WebSocket
- `onConnect(connection)` — real-time progress streaming
- `onMessage(connection, message)` — interactive follow-up questions

---

## Prompt Engineering Strategy

### Phase-based Prompt Architecture

#### Phase 1: Research Planner
```
SYSTEM: You are a research planner. Given a research topic:
1. Decompose into 3-5 sub-topics
2. Generate targeted search queries for each (English + Chinese)
3. Identify authoritative source types to prioritize
4. Estimate research depth needed (quick/surface/deep/comprehensive)

OUTPUT SCHEMA (JSON):
{
  "sub_topics": [{ "title": "...", "queries": ["..."], "source_types": ["..."] }],
  "depth": "comprehensive",
  "estimated_iterations": 3
}
```

#### Phase 2: Search Synthesizer
```
SYSTEM: You are a research synthesizer. Given search results for a sub-topic:
1. Extract key facts with source attribution
2. Note conflicting information across sources
3. Identify knowledge gaps requiring deeper search
4. Rate confidence (HIGH/MEDIUM/LOW) per finding

OUTPUT SCHEMA (JSON):
{
  "findings": [{ "fact": "...", "sources": ["url"], "confidence": "HIGH" }],
  "conflicts": [{ "claim_a": "...", "claim_b": "...", "sources": [...] }],
  "knowledge_gaps": ["..."],
  "needs_deeper_search": boolean
}
```

#### Phase 3: Report Generator
```
SYSTEM: You are a research report writer. Given synthesized findings:
1. Write an executive summary (200 words)
2. Structure findings into logical sections
3. Include inline citations [1], [2], etc.
4. Add a "Limitations & Uncertainties" section
5. Add a "Further Research" section
6. Append full reference list

STYLE: Academic but accessible. Avoid hallucination — only include verified facts.
Mark uncertain claims with [置信度: 中/低].
```

### Key Prompt Techniques (from agents-sdk docs)

1. **Structured Output** — Use JSON schema enforcement for each phase
2. **Chain-of-Thought** — Prompt model to show reasoning before conclusions
3. **Few-Shot Examples** — Include 1-2 example research outputs in system prompt
4. **Negative Constraints** — Explicitly list what NOT to do (e.g., "Do not fabricate citations")
5. **Progressive Disclosure** — Feed previous phase outputs as context for next phase
6. **Confidence Calibration** — Require confidence ratings to flag uncertain findings

---

## Token Management Strategy

### Problem
Gemini models have output token limits. Deep research on a broad topic can easily exceed these.

### Solution: Progressive Chunking Pipeline

1. **Topic Decomposition** → Split broad topic into N sub-topics
2. **Independent Sub-Research** → Each sub-topic researched independently
3. **Per-chunk Summarization** → Each chunk summarized to ~500 words
4. **Cross-chunk Synthesis** → Final model call synthesizes all summaries
5. **Staggered Depth** → Quick scan first, deep-dive only on high-signal areas

### Implementation
```
const MAX_OUTPUT_TOKENS = 8192;  // Gemini limit
const CHUNK_SIZE = 6000;         // Leave room for prompt + overhead

async researchPipeline(topic) {
  const plan = await this.planResearch(topic);         // Phase 1
  const chunks = await this.parallelSearch(plan);      // Phase 2 (fan-out)
  const summaries = await this.summarizeChunks(chunks); // Phase 3
  const report = await this.synthesize(summaries);      // Phase 4
  return report;
}
```

---

## Memory Architecture

### Short-term (Session) Memory
- Stored in `this.state` (Durable Object state)
- Research plan, intermediate findings, current phase
- Survives hibernation, lost on agent termination

### Long-term (Persistent) Memory
- Stored in Durable Object SQLite (`this.sqlite`)
- Past research reports, source trustworthiness scores, topic taxonomy
- Cross-session knowledge accumulation

### Memory Schema (SQLite)
```sql
CREATE TABLE research_sessions (
  id TEXT PRIMARY KEY,
  topic TEXT,
  plan JSON,
  findings JSON,
  report TEXT,
  created_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE sources (
  url TEXT PRIMARY KEY,
  domain TEXT,
  trust_score REAL DEFAULT 0.5,
  times_cited INTEGER DEFAULT 0,
  last_accessed INTEGER
);

CREATE TABLE knowledge_graph (
  entity TEXT,
  relation TEXT,
  target TEXT,
  confidence REAL,
  source_session TEXT
);
```

---

## Code Restructuring Plan

### New File: `src/agent.js` — Main Agent Class
```js
import { AIChatAgent } from "agents-sdk/ai-chat-agent";

export class DeepResearchAgent extends AIChatAgent {
  async onChatMessage(onFinish) {
    // Orchestrate full research pipeline
  }
  
  async planResearch(topic) { /* Phase 1 */ }
  async searchSubTopic(subTopic) { /* Phase 2 - parallel */ }
  async synthesizeFindings(summaries) { /* Phase 3 */ }
  async generateReport(synthesis) { /* Phase 4 */ }
}
```

### New File: `src/prompts.js` — Structured Prompts
```js
export const RESEARCH_PLANNER_PROMPT = `...`;
export const SEARCH_SYNTHESIZER_PROMPT = `...`;
export const REPORT_GENERATOR_PROMPT = `...`;
```

### New File: `src/memory.js` — Memory/SQLite helpers
```js
export class ResearchMemory {
  constructor(sqlite) { this.db = sqlite; }
  async saveSession(session) { /* ... */ }
  async getPastResearch(topic) { /* ... */ }
  async updateSourceTrust(url, score) { /* ... */ }
}
```

### New File: `src/search.js` — Web Search Integration
```js
export async function searchWeb(query, options) { /* Google/Bing API */ }
export async function fetchPage(url) { /* Browser rendering / fetch */ }
export function extractContent(html) { /* Readability-style extraction */ }
```

### Updated: `src/index.js` — Entry Point
```js
export { DeepResearchAgent } from "./agent";
```

### Updated: `wrangler.jsonc` — Durable Object Bindings
```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "DeepResearchAgent", "class_name": "DeepResearchAgent" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["DeepResearchAgent"] }
  ]
}
```

---

## Implementation Priority

### P0 (Must Have — v1)
- [ ] Migrate to AIChatAgent class
- [ ] Phase-based prompt architecture
- [ ] Basic research pipeline (plan → search → synthesize → report)
- [ ] Token-aware chunking
- [ ] SSE streaming for report generation
- [ ] wrangler.jsonc Durable Object bindings

### P1 (Should Have — v2)
- [ ] SQLite-based session memory
- [ ] Source trustworthiness tracking
- [ ] Parallel sub-topic search (fan-out with Promise.all)
- [ ] WebSocket for interactive follow-up
- [ ] Error recovery & retry logic
- [ ] Structured JSON output enforcement

### P2 (Nice to Have — v3)
- [ ] Knowledge graph across research sessions
- [ ] Scheduled periodic research digests
- [ ] React chat UI with useAgent + useAgentChat hooks
- [ ] Multi-model support (Gemini for planning, cheaper model for extraction)
- [ ] Citation verification pass (adversarial check)

---

## Verification Plan

1. `wrangler dev` — local development with SSE streaming test
2. Unit test: prompt templates produce valid JSON
3. Integration test: research a simple topic end-to-end
4. Load test: research a broad topic requiring chunking
5. Verify SQLite persistence across hibernation cycles
