# System Architecture Specification

## AI Agent Backend (Yoho for Vyshnav P C)

This document provides a comprehensive technical overview of the architecture, design principles, data flow, agent graph, security mechanisms, and integration interfaces for the AI Agent backend.

---

## 1. High-Level Architectural Overview

The backend is built as an event-driven, multi-agent AI system on top of **Node.js / TypeScript**, **LangGraph.js**, **Google Gemini** (`gemini-decision-1`, `gemini-flash-lite-latest`, `gemini-3.5-flash-lite`, `gemini-embedding-2`), **PostgreSQL (`pgvector`)**, **Redis**, and **BullMQ**.

It serves two primary roles:
1. **Portfolio Knowledge Assistant**: Answers questions strictly grounded in resume chunks stored in PostgreSQL `pgvector` (`resume_chunks`), returning deterministic scope guardrails for unrelated queries.
2. **Consultation & Meeting Booking Engine**: Dynamically collects visitor details, secures bookings via 6-digit cryptographic email OTPs, enforces a **24-hour SLA commitment**, and emits generative interactive UI widgets for the frontend.

### Component Topology

```mermaid
flowchart TD
    Client["Client / Frontend (React, Next.js, Mobile)"]
    
    subgraph ExpressLayer ["HTTP / SSE API Layer (src/server.ts)"]
        StreamAPI["POST /api/chat/stream (SSE)"]
        RestAPI["POST /api/chat (REST)"]
        IngestAPI["POST /api/ingest (PDF -> pgvector)"]
        HealthAPI["GET /api/health"]
        SwaggerAPI["GET /api/docs (OpenAPI 3.0)"]
    end

    subgraph LangGraphLayer ["LangGraph Agent Graph (src/agent/graph.ts)"]
        Router["decision_router (gemini-decision-1)"]
        Greeting["greeting_small_model (gemini-flash-lite-latest)"]
        Retriever["pgvector_retriever (gemini-embedding-2)"]
        Knowledge["knowledge_big_model (gemini-3.5-flash-lite)"]
        Scheduler["schedule_enquiry (Contact Extractor & Tools)"]
        Tools["AI Tools (src/tools/index.ts)"]
    end

    subgraph DataLayer ["Data & Asynchronous Services"]
        PgVectorDB[("PostgreSQL pgvector (resume_chunks)")]
        RedisDB[("Redis (Sessions, OTPs, Bookings)")]
        BullQueue["BullMQ Email Queue (src/queues/emailQueue.ts)"]
        Worker["Email Background Worker (src/workers/emailWorker.ts)"]
        SMTP["SMTP Mail Server (Nodemailer)"]
        GeminiAPI["Google Gemini API"]
    end

    Client -->|SSE Request| StreamAPI
    Client -->|REST Request| RestAPI
    StreamAPI --> LangGraphLayer
    RestAPI --> LangGraphLayer
    IngestAPI --> PgVectorDB

    Router -->|greeting| Greeting
    Router -->|knowledge_query| Retriever
    Router -->|schedule_enquiry| Scheduler
    Retriever --> PgVectorDB
    Retriever --> Knowledge

    Greeting --> GeminiAPI
    Knowledge --> GeminiAPI
    Scheduler --> Tools
    Tools -->|send_verification_otp| BullQueue
    Tools -->|verify_otp| RedisDB
    Tools -->|schedule_enquiry| RedisDB

    BullQueue --> Worker
    Worker --> SMTP
    LangGraphLayer -.-> RedisDB
    ExpressLayer -->|SSE Events / JSON| Client
```

---

## 2. Multi-Agent LangGraph State Machine

The core intelligence is modeled as a stateful computational graph using **LangGraph.js** ([src/agent/graph.ts](../src/agent/graph.ts)).

### Execution Flow & Routing
1. **Decision Router (`decision_router`)**: Uses `gemini-decision-1` with recent assistant context (`buildDecisionInput`) to classify messages into `greeting`, `schedule_enquiry`, `knowledge_query` (`profile_query`), or `out_of_scope` (returns deterministic boundary message directly to `END`).
2. **Greeting Node (`greeting_small_model`)**: Handles greetings fast without hitting PostgreSQL.
3. **PostgreSQL Vector Retriever (`pgvector_retriever`)**: Embeds the query via `generateTextEmbedding` and runs cosine similarity search (`searchResumeChunks`) strictly against `resume_chunks` in PostgreSQL.
4. **Knowledge Synthesizer (`knowledge_big_model`)**: Generates concise answers grounded strictly in retrieved `pgvector` chunks (returning an empty-context fallback prompt if no chunks exist).
5. **Schedule Enquiry (`schedule_enquiry`)**: Extracts `name`, `email`, `phone`, `reason`, and `otp`, dispatching verification emails and persisting confirmed leads in Redis.

### State Schema (`AgentStateType`)

```typescript
export interface AgentStateType {
  messages: BaseMessage[];              // Conversational history
  intent?: 'greeting' | 'profile_query' | 'schedule_enquiry' | 'direct' | 'out_of_scope' | string;
  finalMessage?: string;                // Final plain-text reply
  extractedKeywords?: string;           // Search query for pgvector
  retrievedDocs?: RetrievedDocument[];  // Retrieved pgvector resume chunks
  leadInfo?: LeadInfo;                  // Captured visitor contact details across turns
  isVerified?: boolean;                 // Email OTP verification status
  uiAction?: Record<string, any> | null;// Generative UI action descriptor
}
```

### Node Responsibilities

| Node Name | File | Primary Responsibility | Model / Engine |
| :--- | :--- | :--- | :--- |
| **`decisionRouterNode`** | [decisionRouterNode.ts](../src/agent/nodes/decisionRouterNode.ts) | Classifies user intent with prior assistant context and handles `out_of_scope` cutoffs. | `gemini-decision-1` |
| **`greetingSmallModelNode`** | [greetingNode.ts](../src/agent/nodes/greetingNode.ts) | Responds warmly to greetings with zero DB lookup. | `gemini-flash-lite-latest` |
| **`pgVectorRetrieverNode`** | [pgVectorRetrieverNode.ts](../src/agent/nodes/pgVectorRetrieverNode.ts) | Embeds query text and retrieves top chunks from PostgreSQL `resume_chunks`. | `gemini-embedding-2` + PostgreSQL |
| **`bigModelKnowledgeNode`** | [knowledgeNode.ts](../src/agent/nodes/knowledgeNode.ts) | Synthesizes grounded answers strictly from retrieved chunks. | `gemini-3.5-flash-lite` |
| **`scheduleEnquiryNode`** | [scheduleEnquiryNode.ts](../src/agent/nodes/scheduleEnquiryNode.ts) | Extracts lead fields/OTP and calls OTP & booking tools. | `gemini-flash-lite-latest` |

---

## 3. PostgreSQL `pgvector` Knowledge Storage

Portfolio knowledge is indexed from a resume PDF via [ingestResumePdf.ts](../src/scripts/ingestResumePdf.ts) (`npm run ingest:pdf` or `POST /api/ingest`) and stored exclusively in the PostgreSQL `resume_chunks` table managed by [pgVectorService.ts](../src/services/pgVectorService.ts) (with cosine similarity HNSW indexing).

---

## 4. Generative UI Action Architecture

The AI model autonomously determines when to trigger interactive client-side components:

### The Tool-Driven UI Flow

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Frontend
    participant Server as Express SSE Handler
    participant Agent as scheduleEnquiryNode
    participant Tools as Tool Registry (tools/index.ts)
    participant Redis as Redis Session Store

    User->>Server: "I want to schedule a meeting with Vyshnav"
    Server->>Agent: Run decision_router -> scheduleEnquiryNode
    Agent-->>Server: Requests missing name and email
    Server-->>User: Prompt for name & email

    User->>Server: Submits { name: "Alex", email: "alex@example.com" }
    Server->>Agent: Run decision_router -> scheduleEnquiryNode
    Agent-->>Server: Prompts for missing phone number & reason
    Server-->>User: Request phone number & reason

    User->>Server: Submits { phone: "+1 555-0100", reason: "Architecture review" }
    Server->>Agent: Run decision_router -> scheduleEnquiryNode
    Agent->>Tools: Invoke send_verification_otp({ email: "alex@example.com", name: "Alex" })
    Tools-->>Agent: Returns uiAction: { type: 'otp_input', email: "alex@example.com", length: 6 }
    Agent-->>Server: Final State with uiAction & AI message
    Server-->>User: SSE event: ui_action (otp_input)
    Note over User: Frontend dynamically mounts inline 6-Digit OTP Widget!

    User->>Server: Submits 6-digit OTP "123456"
    Server->>Agent: Run decision_router -> scheduleEnquiryNode
    Agent->>Tools: Invoke verify_otp({ email, otp: "123456" })
    Tools->>Redis: Check SHA-256 hash
    Tools-->>Agent: Verification Success (uiAction: null)
    Agent->>Tools: Invoke schedule_enquiry(...)
    Tools->>Redis: Save confirmed booking
    Agent-->>Server: Reply + Guaranteed "24 hours" SLA statement
    Server-->>User: SSE event: token & done
```

### Supported UI Action Descriptors

1. **`otp_input`**: Emitted immediately upon generating and dispatching an email OTP.

---

## 5. Security & Cryptographic Verification Engine

- **Cryptographic Random Generation**: OTPs are generated using Node's `crypto.randomInt(100000, 1000000)`.
- **Zero Plaintext Storage**: Redis never stores OTPs in plain text. Every OTP is hashed with `SHA-256` prior to persistence (`otp:${email}`).
- **Constant-Time Verification**: Verification uses `crypto.timingSafeEqual(storedHash, providedHash)` to prevent timing side-channel attacks.
- **Brute-Force Rate Limiting**: Max 3 verification attempts per OTP. On the 3rd failed attempt, the key is evicted immediately.
- **Auto-Expiration TTL**: Unverified OTPs expire automatically after 10 minutes (`EX 600`).
- **Idempotent Background Dispatch**: BullMQ handles outbound email delivery asynchronously with exponential backoff (`attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`), decoupling user-facing HTTP latency from SMTP server response times.

---

## 6. Server-Sent Events (SSE) Streaming Protocol

Real-time streaming is implemented via `POST /api/chat/stream` and `GET /api/chat/stream`.

### Event Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant Server as Express SSE Streamer
    participant Agent as LangGraph Engine

    Client->>Server: POST /api/chat/stream
    Server->>Client: Headers: Content-Type: text/event-stream, X-Accel-Buffering: no
    
    Server->>Client: event: status\ndata: {"status": "understanding_query"}
    Server->>Client: event: status\ndata: {"status": "extracting_facts"}
    Server->>Client: event: status\ndata: {"status": "synthesizing_answer"}
    
    loop Stream Output
        Agent->>Server: Yield chunk
        Server->>Client: event: token\ndata: {"token": "Vyshnav "}
        Server->>Client: event: token\ndata: {"token": "is "}
    end

    opt Generative UI Emitted
        Server->>Client: event: ui_action\ndata: {"type": "form_input", ...}
    end

    Server->>Client: event: done\ndata: {"reply": "...", "conversationId": "..."}
```

---

## 7. Configuration & Multi-Provider Architecture

The agent supports automatic routing across multiple LLM providers configured via environment variables:

- **Primary Provider**: Google Gemini (`gemini-decision-1`, `gemini-flash-lite-latest`, `gemini-3.5-flash-lite`, `gemini-embedding-2` via Google AI Studio).
- **Alternative Providers**: Groq (`openai/gpt-oss-120b`), NVIDIA NIM (`nvidia/nemotron-3.5-lightning-30b-a3b`), and OpenRouter (`openrouter/free`).
- **Token Configuration**: `maxTokens: 2048` configured in `src/agent/llm/modelFactory.ts` to ensure detailed responses render without truncation.

---

## 8. Directory & File Reference

- [src/server.ts](../src/server.ts) — Express REST & SSE streaming server.
- [src/http/routes/chatRoutes.ts](../src/http/routes/chatRoutes.ts) & [systemRoutes.ts](../src/http/routes/systemRoutes.ts) — Chat, health, ingest, docs, and enquiries routes.
- [src/agent/graph.ts](../src/agent/graph.ts) — LangGraph state graph compilation and routing.
- [src/agent/nodes.ts](../src/agent/nodes.ts) & `src/agent/nodes/*` — Modular LangGraph nodes (`decisionRouterNode`, `greetingSmallModelNode`, `pgVectorRetrieverNode`, `bigModelKnowledgeNode`, `scheduleEnquiryNode`).
- [src/agent/state.ts](../src/agent/state.ts) — TypeScript state channel schemas.
- [src/services/pgVectorService.ts](../src/services/pgVectorService.ts) & [embeddingService.ts](../src/services/embeddingService.ts) — PostgreSQL `pgvector` search/storage and vector embeddings.
- [src/scripts/ingestResumePdf.ts](../src/scripts/ingestResumePdf.ts) — Resume PDF chunker and PostgreSQL `pgvector` indexer.
- [src/tools/index.ts](../src/tools/index.ts) — AI tools and generative UI action definitions.
- [src/services/otpService.ts](../src/services/otpService.ts) — Cryptographic OTP generation, hashing, and verification.
- [src/services/redisClient.ts](../src/services/redisClient.ts) — Redis client connection and key utilities.
- [src/queues/emailQueue.ts](../src/queues/emailQueue.ts) — BullMQ email queue producer.
- [src/workers/emailWorker.ts](../src/workers/emailWorker.ts) & [emailTemplates.ts](../src/workers/emailTemplates.ts) — BullMQ background worker and HTML-escaped email templates.
- [docs/FRONTEND_INTEGRATION_GUIDE.md](FRONTEND_INTEGRATION_GUIDE.md) — Comprehensive frontend SSE integration guide with React/Next.js code.
