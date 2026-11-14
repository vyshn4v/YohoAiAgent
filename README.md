# AI Agent Backend: Yoho (Vyshnav P C's Portfolio Assistant)

A production-grade, multi-agent AI backend service built with **TypeScript**, **LangGraph.js**, **OpenRouter**, **Pinecone**, **BullMQ**, and **Redis**.

The service powers **Yoho**, the dedicated AI assistant for **[Vyshnav P C](https://portfolio.vyshnavpc.com/)** (Full-Stack & Generative AI Developer based in Kannur, Kerala). It combines Retrieval-Augmented Generation (RAG) strictly grounded in verified portfolio facts with an automated meeting/consultation scheduling workflow backed by OTP email verification.

---

## 🌟 Core Capabilities

1. **Multi-Agent RAG Knowledge Assistant (Strictly No Web Search)**:
   - Answers questions regarding Vyshnav's background, production experience (SDE-I at Neutrinos, Sunlife Philippines, 1,000–2,000 req/min decision engine), flagship systems ([Domain Scanner SaaS](https://domainscanner.vyshnavpc.com), QStack), tech stack, and [LixerLab](https://lixerlab.vyshnavpc.com/) agency services.
   - Uses a 3-agent orchestration graph:
     - **Agent 1 (Intent & Context Classifier)**: Discerning profile queries from scheduling requests and general greetings.
     - **Pinecone Vector Search / Local Fallback**: Performs vector similarity search over chunked markdown knowledge in `src/data/profile.md`.
     - **Agent 2 (Relevance Classifier)**: Filters out irrelevant chunks to prevent hallucination.
     - **Agent 3 (Profile Synthesizer)**: Formulates friendly, fact-grounded responses with natural emojis and context.

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
                         [Intent Classification]
                                     |
               +---------------------+---------------------+
               |                                           |
    [Intent: profile_query]                     [Intent: schedule_enquiry]
               |                                           |
+------------------------------+             +------------------------------+
| Agent 1: Keyword Extractor   |             | Enquiry & Tool Coordinator   |
+--------------+---------------+             +--------------+---------------+
               |                                            |
+------------------------------+             +------------------------------+
| Pinecone Vector Retrieval    |             | 1. send_verification_otp     |
| (Fallback: Local Chunks)     |             |    -> Encrypt & save in Redis|
+--------------+---------------+             |    -> Enqueue BullMQ mail job|
               |                             | 2. verify_otp                |
+------------------------------+             |    -> Constant-time compare  |
| Agent 2: Relevance Classifier|             |    -> Set verified in Redis  |
+--------------+---------------+             | 3. schedule_enquiry          |
               |                             |    -> Require verified email |
+------------------------------+             |    -> Promise 24h response   |
| Agent 3: Profile Synthesizer |             +--------------+---------------+
| (Strictly verified facts)    |                            |
+--------------+---------------+                            |
               |                                            |
               +---------------------+----------------------+
                                     |
                                [Response]
```

---

## 📁 Repository Structure

```
AiAgent/
├── data/
│   └── profile.md               # Synchronized profile markdown
├── src/
│   ├── agent/                   # LangGraph multi-agent state machine & nodes
│   │   ├── graph.ts             # StateGraph definition & conditional edges
│   │   ├── nodes.ts             # Agent nodes (Intent, Relevance, Synthesizer, Enquiry)
│   │   └── state.ts             # LangGraph state annotations & Lead schema
│   ├── config/                  # Environment variable validation & defaults
│   ├── data/
│   │   └── profile.md           # Ground-truth profile & knowledge base document
│   ├── docs/                    # OpenAPI / Swagger specification
│   ├── queues/                  # BullMQ email queue producer & connection setup
│   ├── scripts/
│   │   ├── cliChat.ts           # Interactive terminal CLI chat for testing
│   │   └── ingest.ts            # Chunks & embeds profile.md into Pinecone
│   ├── services/
│   │   ├── emailService.ts      # Nodemailer SMTP transporter & templates
│   │   ├── otpService.ts        # OTP generation, Redis crypto storage, and verification
│   │   └── pineconeService.ts   # Vector embeddings & Pinecone semantic search
│   ├── tools/                   # LangChain tool definitions (OTP & Scheduling)
│   ├── workers/                 # BullMQ background consumer worker
│   └── server.ts                # Express REST API, CORS, SSE streaming & Swagger UI
├── tests/                       # Vitest integration & unit test suite
├── package.json
└── README.md
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18+ (tested on Node v26)
- **Redis**: Local Redis (`redis-server`), WSL2, Docker, or managed cloud Redis (e.g. [Upstash](https://upstash.com)).
- **OpenRouter API Key**: For LLM calls (`https://openrouter.ai`).
- **Pinecone API Key**: (Optional for local development; system automatically falls back to local semantic chunks from `src/data/profile.md`).

### 2. Environment Configuration
Copy `.env.example` to `.env` and configure your credentials:
```bash
cp .env.example .env
```

Key environment variables:
| Variable | Description |
| :--- | :--- |
| `PORT` | API server port (default: `3000`). |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM execution. |
| `OPENROUTER_MODEL` | Model identifier (e.g. `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`). |
| `REDIS_HOST`, `REDIS_PORT` | Connection host and port for Redis. |
| `REDIS_PASSWORD` | Redis password (leave empty if none). |
| `PINECONE_API_KEY` | Pinecone API key. |
| `PINECONE_INDEX_NAME` | Pinecone index name (e.g. `ai-agent-dev`). |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | SMTP credentials for sending verification emails. |
| `HOST_EMAIL` | Destination inbox for verified lead notifications. |
| `CORS_ORIGIN` | Allowed CORS origins (e.g. `*` or `https://portfolio.vyshnavpc.com`). |

### 3. Knowledge Base Profile (`src/data/profile.md`)
The profile file at `src/data/profile.md` contains the complete knowledge base scraped directly from [https://portfolio.vyshnavpc.com/](https://portfolio.vyshnavpc.com/):
- **Overview & Identity:** SDE-I, full-stack, distributed systems, and agentic AI.
- **Experience:** Neutrinos (Sunlife Philippines enterprise project, 1,000–2,000 req/min decision engine).
- **Flagship Projects:** [Domain Scanner SaaS](https://domainscanner.vyshnavpc.com) and QStack modular monolith.
- **Agency Initiative:** [LixerLab](https://lixerlab.vyshnavpc.com/).
- **Certifications & Education:** AWS Solutions Architect, Meta, Udemy, Akshay Saini verified courses, and Brototype Bootcamp.
- **Scheduling Policy:** 24h follow-up guarantee, OTP requirements, and contact validation.

To index this profile into your Pinecone vector database:
```bash
npm run ingest
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
Test conversation, profile inquiries, and multi-turn meeting scheduling directly in your terminal:
```bash
npm run test:chat
```

### 7. Running the Test Suite
Execute the automated Vitest test suite (includes LangGraph orchestrations, tool executions, E2E multi-turn scheduling, and API endpoints):
```bash
npm test
```

---

## 📡 API Reference & Swagger UI

Interactive Swagger UI documentation is available at:
- **Swagger UI Interface**: `http://localhost:3000/api/docs`
- **OpenAPI 3.0 JSON Spec**: `http://localhost:3000/api/docs.json`
- **Root URL (`/`)**: Automatically redirects to `/api/docs`

### Key Endpoints

#### 1. `POST /api/chat`
Send a synchronous message to the multi-agent system.
```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What projects has Vyshnav built?", "conversationId": "session-1"}'
```
**Response:**
```json
{
  "reply": "Vyshnav has engineered notable production systems including Domain Scanner...",
  "conversationId": "session-1",
  "intent": "profile_query",
  "retrievedCount": 2
}
```

#### 2. `POST /api/chat/stream` or `GET /api/chat/stream` (SSE)
Real-time streaming over Server-Sent Events. Emits:
- `event: status`: Status updates (`searching_knowledge_base`, `generating_answer`, `coordinating_tools`).
- `event: token`: Incremental tokens as generated by the LLM.
- `event: done`: Final message object with conversation metadata.

#### 3. `GET /api/health`
Checks health and connectivity of Redis, OpenRouter, and Pinecone.

#### 4. `POST /api/ingest`
Triggers semantic chunking and embedding of `src/data/profile.md` into Pinecone.

#### 5. `GET /api/enquiries`
Retrieves all confirmed and verified meeting bookings.

---

## 🔒 Security & Spam Prevention

- **Strict RAG Grounding**: The Profile Synthesizer agent is instructed to **never browse the live internet** and **never hallucinate** outside the verified markdown profile chunks.
- **Constant-Time OTP Validation**: OTP verification uses cryptographic constant-time comparison to protect against timing attacks.
- **Short-Lived Ephemeral State**: OTP codes expire in 5 minutes in Redis and are destroyed immediately upon successful verification.
- **Rate-Limiting & Sanitization**: Anti-abuse limits on OTP dispatch to prevent mail bombing.

---

## 📄 License
ISC © [Vyshnav P C](https://portfolio.vyshnavpc.com/)
