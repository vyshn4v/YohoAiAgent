# AI Agent Backend: Yoho (Vyshnav P C's Portfolio Assistant)

A production-grade, multi-agent AI backend service built with **TypeScript**, **LangGraph.js**, **Google Gemini**, **In-Memory Structured Profile Slicing**, **BullMQ**, and **Redis**.

The service powers **Yoho**, the dedicated AI assistant for **[Vyshnav P C](https://portfolio.vyshnavpc.com/)** (Full-Stack & Generative AI Developer based in Kannur, Kerala). It combines a 3-tier LangGraph architecture grounded in verified portfolio facts with an automated meeting/consultation scheduling workflow backed by OTP email verification.

---

## 🌟 Core Capabilities

1. **Multi-Agent Knowledge Assistant (Strictly No Web Search)**:
   - Answers questions regarding Vyshnav's background, production experience (SDE-I at Neutrinos, Sunlife Philippines, 1,000–2,000 req/min decision engine), flagship systems ([Domain Scanner SaaS](https://domainscanner.vyshnavpc.com), [YohoAiAgent](https://github.com/vyshn4v/YohoAiAgent)), tech stack, and [LixerLab](https://lixerlab.vyshnavpc.com/) agency services.
   - **Zero-Token In-Memory Profile Slicing**: Slices relevant sections from `src/data/profile.json` in `0ms` with zero token waste.
   - **Clean Plain-Text Guardrails**: Outputs clean markdown with standard bullet points (`-`), strictly zero HTML tags (`<br>`, `<table>`, etc.), and zero unsolicited tips or conclusions.
   - Uses a 3-phase orchestration graph:
     - **Phase 1 (`firstRouterAndUiNode`)**: Classifies intent, extracts contact details and OTP codes, and resolves direct chats in 1 AI call.
     - **Phase 2 (`secondExtractorNode`)**: Extracts verified facts from sliced `profile.json` data via structured schema.
     - **Phase 3 (`thirdGeneratorNode`)**: Synthesizes clean, direct answers as **Yoho** with zero hallucination.

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
                     [Phase 1: firstRouterAndUiNode]
                                     |
               +---------------------+---------------------+
               |                                           |
    [Intent: profile_query]                     [Intent: direct / schedule / greeting]
               |                                           |
+------------------------------+             +------------------------------+
| In-Memory Slicing            |             | Direct AI Response / Booking |
| (src/data/profile.json)      |             | 1. send_verification_otp     |
+--------------+---------------+             |    -> SHA-256 hash in Redis  |
               |                             |    -> Enqueue BullMQ mail job|
+------------------------------+             | 2. verify_otp                |
| Phase 2: Fact Extractor      |             |    -> Constant-time compare  |
| (Structured JSON facts)      |             |    -> Set verified in Redis  |
+--------------+---------------+             | 3. schedule_enquiry          |
               |                             |    -> Require verified email |
+------------------------------+             |    -> Promise 24h SLA        |
| Phase 3: Response Synthesizer|             +--------------+---------------+
| (Clean plain text, no HTML)  |                            |
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
│   └── profile.json             # Synchronized profile database
├── src/
│   ├── agent/                   # LangGraph multi-agent state machine & nodes
│   │   ├── graph.ts             # StateGraph definition & conditional edges
│   │   ├── nodes.ts             # 3-Phase agent nodes (Router, Extractor, Generator)
│   │   └── state.ts             # LangGraph state annotations & Lead schema
│   ├── config/                  # Multi-provider environment configuration (Gemini, Groq, NVIDIA, OpenRouter)
│   ├── data/
│   │   └── profile.json         # Ground-truth structured portfolio database
│   ├── docs/                    # OpenAPI / Swagger specification
│   ├── queues/                  # BullMQ email queue producer & connection setup
│   ├── scripts/
│   │   ├── cliChat.ts           # Interactive terminal CLI chat for testing
│   │   └── ingest.ts            # Optional Pinecone vector ingestion script
│   ├── services/
│   │   ├── emailService.ts      # Nodemailer SMTP transporter & templates
│   │   ├── otpService.ts        # OTP generation, Redis crypto storage, and verification
│   │   ├── profileLoader.ts     # In-memory category slicer and typed JSON loader
│   │   └── pineconeService.ts   # Optional vector search service
│   ├── tools/                   # AI tool definitions (OTP & Scheduling)
│   ├── workers/                 # BullMQ background consumer worker
│   └── server.ts                # Express REST API, CORS, SSE streaming & Swagger UI
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
| `GEMINI_MODEL` | Active model identifier | `gemini-flash-lite-latest` |
| `REDIS_HOST`, `REDIS_PORT` | Connection host and port for Redis | `localhost`, `6379` |
| `REDIS_PASSWORD` | Redis password (leave empty if none) | `""` |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | SMTP credentials for sending verification emails | — |
| `HOST_EMAIL` | Destination inbox for verified lead notifications | `vyshnavpcnaravoor@gmail.com` |
| `CORS_ORIGIN` | Allowed CORS origins | `*` |

### 3. Ground Truth Profile Database (`src/data/profile.json`)
All facts are centralized in `src/data/profile.json`:
- **Identity & Bio:** SDE-I, full-stack, distributed systems, and agentic AI.
- **Experience:** Neutrinos (Sunlife Philippines enterprise project, 1,000–2,000 req/min decision engine).
- **Flagship Projects:** [Domain Scanner SaaS](https://domainscanner.vyshnavpc.com) and [YohoAiAgent](https://github.com/vyshn4v/YohoAiAgent).
- **Agency Initiative:** [LixerLab](https://lixerlab.vyshnavpc.com/).
- **Certifications & Education:** AWS Solutions Architect, Meta, Udemy, Akshay Saini verified courses, Brototype Bootcamp.
- **Scheduling Policy:** 24h follow-up guarantee, OTP requirements, and contact validation.

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

1. **Strictly Grounded (No Web Search)**: Yoho answers queries strictly from the verified facts in `src/data/profile.json`.
2. **Pure Plain Text (No HTML)**: The prompt strictly forbids HTML tags (`<br>`, `<table>`, `<tr>`, `<td>`, `<p>`, `<div>`). Output is rendered as standard markdown bullets (`-`).
3. **No Unsolicited Wrap-Ups**: Concluding summaries, commentary, and tips (e.g. `"💡 Tip:"`, `"✨ Summary:"`) are completely suppressed.
4. **24-Hour SLA Commitment**: All booking and consultation flows commit to a personal response from Vyshnav within 24 hours.

---

## 📄 License
ISC © Vyshnav P C
