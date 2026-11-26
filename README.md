# AI Agent Backend: Yoho (Vyshnav P C's Portfolio Assistant)

A production-grade, multi-agent AI backend service built with **TypeScript**, **LangGraph.js**, **Google Gemini**, **PostgreSQL (`pgvector`)**, **BullMQ**, and **Redis**.

The service powers **Yoho**, the dedicated AI assistant for **[Vyshnav P C](https://portfolio.vyshnavpc.com/)** (Full-Stack & Generative AI Developer based in Kannur, Kerala). It combines a 4-tier LangGraph RAG pipeline backed by PostgreSQL `pgvector` with an automated meeting/consultation scheduling workflow and OTP email verification.

---

## 🌟 Core Capabilities

1. **Multi-Agent Knowledge Assistant (Strictly PostgreSQL `pgvector` RAG)**:
   - Answers questions regarding Vyshnav's background, experience, projects, and tech stack grounded strictly in chunks retrieved from PostgreSQL (`resume_chunks`).
   - Uses a 4-tier LangGraph workflow ([src/agent/graph.ts](src/agent/graph.ts)):
     - **`decision_router` (`decisionRouterNode`)**: Classifies intent using `gemini-decision-1` (`greeting`, `schedule_enquiry`, `knowledge_query`, or `out_of_scope` zero-AI cutoff).
     - **`greeting_small_model` (`greetingSmallModelNode`)**: Instant greeting replies via `gemini-flash-lite-latest` without querying the vector DB.
     - **`pgvector_retriever` (`pgVectorRetrieverNode`)**: Generates query embeddings (`gemini-embedding-2`) and queries PostgreSQL `pgvector` (`resume_chunks`).
     - **`knowledge_big_model` (`bigModelKnowledgeNode`)**: Synthesizes concise answers from retrieved chunks via `gemini-3.5-flash-lite`.
     - **`schedule_enquiry` (`scheduleEnquiryNode`)**: Extracts contact details (`name`, `email`, `phone`, `reason`, `otp`) and runs OTP verification / booking tools.

2. **Autonomous Meeting & Consultation Booking with OTP Verification**:
   - Enables prospective clients, recruiters, and collaborators to book consultations directly through the chat.
   - Gathers contact details (`name`, `email`, `phone`, `reason for connecting`).
   - Requires email verification via a 6-digit OTP code dispatched asynchronously using **BullMQ**, **Redis**, and **Nodemailer**.
   - Guarantees a personal follow-up from Vyshnav within **24 hours**.

3. **Real-Time Server-Sent Events (SSE) Streaming**:
   - Streams LLM tokens and status updates in real-time over SSE.
   - Full cross-origin (CORS) support for decoupled frontend SPAs hosted on custom domains or subdomains.

> 📚 **Complete Architecture & Integration Guides**:
> - [System Architecture Specification](docs/ARCHITECTURE.md)
> - [Frontend Integration Guide](docs/FRONTEND_INTEGRATION_GUIDE.md)

---

## 🏗️ Architecture & Orchestration Flow

```
                      +-----------------------------+
                      |   User /api/chat Request   |
                      +--------------+--------------+
                                     |
                     [Node 1: decision_router (gemini-decision-1)]
                                     |
         +---------------------------+---------------------------+
         |                           |                           |
 [knowledge_query]           [greeting / out_of_scope]    [schedule_enquiry]
         |                           |                           |
+------------------------+   +--------------------+   +----------------------------+
| pgvector_retriever     |   | Greeting / Cutoff  |   | 1. send_verification_otp   |
| (PostgreSQL pgvector)  |   +---------+----------+   |    -> SHA-256 hash in Redis|
+-----------+------------+             |              |    -> Enqueue BullMQ job   |
            |                          |              | 2. verify_otp              |
+------------------------+             |              | 3. schedule_enquiry        |
| knowledge_big_model    |             |              |    -> Require verified     |
| (gemini-3.5-flash-lite)|             |              |    -> Promise 24h SLA      |
+-----------+------------+             |              +-------------+--------------+
            |                          |                            |
            +--------------------------+----------------------------+
                                       |
                                  [Response]
```

---

## 📁 Repository Structure

```
AiAgent/
├── data/                        # Resume PDF source for ingestion (data/resume.pdf)
├── src/
│   ├── agent/                   # LangGraph multi-agent state machine & nodes
│   │   ├── llm/modelFactory.ts  # Gemini & OpenAI-compatible model factory
│   │   ├── nodes/               # Per-node modules (decisionRouter, greeting, pgVectorRetriever, knowledge, scheduleEnquiry)
│   │   ├── utils/messageUtils.ts# Shared message & LangSmith helpers
│   │   ├── graph.ts             # StateGraph definition & conditional edges
│   │   ├── nodes.ts             # Node barrel re-exports
│   │   └── state.ts             # LangGraph state annotations & Lead schema
│   ├── config/                  # Multi-provider environment & pgvector configuration
│   ├── docs/                    # OpenAPI / Swagger specification
│   ├── http/                    # Express routers, CORS, SSE streamer & session store
│   ├── queues/                  # BullMQ email queue producer & connection setup
│   ├── scripts/
│   │   ├── cliChat.ts           # Interactive terminal CLI chat for testing
│   │   └── ingestResumePdf.ts   # Resume PDF -> PostgreSQL pgvector ingestion script
│   ├── services/
│   │   ├── embeddingService.ts  # Gemini vector embeddings & deterministic test fallback
│   │   ├── otpService.ts        # OTP generation, Redis crypto storage, and verification
│   │   ├── pgVectorService.ts   # PostgreSQL pgvector table, replace & cosine search
│   │   └── redisClient.ts       # Redis client singleton
│   ├── tools/                   # AI tool definitions (OTP & Scheduling)
│   ├── utils/                   # Structured node logger
│   ├── workers/                 # BullMQ background email consumer & templates
│   └── server.ts                # Express server entrypoint
├── docs/
│   ├── ARCHITECTURE.md          # Comprehensive architecture specification
│   └── FRONTEND_INTEGRATION_GUIDE.md # Frontend SSE integration & widgets
├── tests/                       # Vitest integration & unit test suite
├── package.json
└── README.md
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18+ (tested on Node v20/v26)
- **PostgreSQL + `pgvector`**: PostgreSQL database with `vector` extension enabled (`DATABASE_URL`).
- **Redis**: Local Redis (`redis-server`), WSL2, Docker, or managed cloud Redis.
- **Google Gemini API Key**: Free tier API key from [Google AI Studio](https://aistudio.google.com/).

### 2. Environment Configuration
Copy `.env.example` to `.env` and configure your credentials:
```bash
cp .env.example .env
```

Key environment variables:
| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | API server port | `3000` |
| `LLM_PROVIDER` | Active LLM provider (`gemini`, `groq`, `nvidia`, `openrouter`) | `gemini` |
| `GEMINI_API_KEY` | Google AI Studio API key | (Required) |
| `GEMINI_BASE_URL` | OpenAI-compatible endpoint | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| `GEMINI_MODEL` | Active model identifier | `gemini-flash-latest` |
| `DATABASE_URL` | PostgreSQL connection URL for `pgvector` | `postgresql://postgres:postgres@localhost:5432/portfolio_db` |
| `REDIS_HOST`, `REDIS_PORT` | Connection host and port for Redis | `localhost`, `6379` |
| `REDIS_PASSWORD` | Redis password (leave empty if none) | `""` |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | SMTP credentials for sending verification emails | — |
| `HOST_EMAIL` | Destination inbox for verified lead notifications (users should configure a valid destination for notifications) | `vyshnav@example.com` |
| `CORS_ORIGIN` | Allowed CORS origins | `*` |

### 3. Indexing Resume Knowledge (`pgvector`)
Place a resume PDF at `data/resume.pdf` (or set `RESUME_PDF_PATH`) and index chunks into PostgreSQL `resume_chunks`:
```bash
npm run ingest:pdf
```

### 4. Running the Development Server
```bash
# Starts Express server with hot-reload (also initializes BullMQ worker in dev mode)
npm run dev
```

### 5. Running the Background Email Worker (Production)
```bash
# Runs the standalone BullMQ consumer worker
npm run worker
```

### 6. Interactive Terminal Chat
Test conversational flows directly in your terminal:
```bash
npm run test:chat
```

### 7. Running the Test Suite
```bash
npm test
```

---

## 🛡️ Guardrails & Formatting Rules

1. **Strictly Grounded (No Web Search)**: Yoho answers portfolio questions from chunks retrieved from PostgreSQL `pgvector` (`resume_chunks`) and cuts off unrelated queries in `decision_router`.
2. **Pure Plain Text (No HTML)**: The prompt strictly forbids HTML tags (`<br>`, `<table>`, `<tr>`, `<td>`, `<p>`, `<div>`). Output is rendered as standard markdown bullets (`-`).
3. **No Unsolicited Wrap-Ups**: Concluding summaries, commentary, and tips (e.g. `"💡 Tip:"`, `"✨ Summary:"`) are completely suppressed.
4. **24-Hour SLA Commitment**: All booking and consultation flows commit to a personal response from Vyshnav within 24 hours.

---

## 📄 License
ISC © Vyshnav P C
