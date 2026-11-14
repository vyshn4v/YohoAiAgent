# Professional Profile & Knowledge Base: Vyshnav P C

## Overview & Executive Summary
- **Name:** Vyshnav P C
- **Headline / Title:** Full-Stack & Generative AI Developer | Freelancer based in Kannur, Kerala, India
- **AI Assistant Name:** Yoho (exclusive portfolio & scheduling AI assistant)
- **Location:** Kannur, Kerala, India (Available for remote contracts, SDE backend roles, and worldwide freelance projects)
- **Experience Stat:** 2+ years of production experience in backend, distributed systems, and agentic AI
- **Hero Statement:** "Building Systems That Scale."
- **Core Philosophy:** "I engineer high-throughput backend services, resilient distributed workflows, and end-to-end production systems."
- **Key Metrics:**
  - `1,000–2,000 requests/minute`: Enterprise decision engine orchestration throughput.
  - `100%`: End-to-end production delivery and migration ownership.
- **Summary:** Full-stack and Generative AI developer with 2+ years of production experience engineering intelligent AI agents, modern web applications, and high-throughput backend services. Designed and built an enterprise decision engine processing 1,000 to 2,000 requests per minute for automated insurance scheduling and policy workflows, and delivered resilient microservices with Node.js, NestJS, React, TypeScript, PostgreSQL, Redis, RabbitMQ, and Docker. Available for freelance projects, technical engineering consulting, and digital agency collaborations via LixerLab.

---

## Contact Details & Professional Links
- **Email Direct:** [vyshnavpcnaravoor@gmail.com](mailto:vyshnavpcnaravoor@gmail.com)
- **Phone Direct:** [+91 8086064478](tel:+918086064478)
- **Live Portfolio:** [https://portfolio.vyshnavpc.com/](https://portfolio.vyshnavpc.com/)
- **Digital Agency:** [LixerLab (https://lixerlab.vyshnavpc.com/)](https://lixerlab.vyshnavpc.com/)
- **GitHub:** [https://github.com/vyshn4v](https://github.com/vyshn4v)
- **LinkedIn:** [https://www.linkedin.com/in/vyshnav-p-c-5567ba242/](https://www.linkedin.com/in/vyshnav-p-c-5567ba242/)
- **LeetCode:** [https://leetcode.com/u/vyshnavpcnaravoor](https://leetcode.com/u/vyshnavpcnaravoor)
- **Resume (PDF):** [Download Resume](https://portfolio.vyshnavpc.com/Resume_vyshnavPC.pdf)

---

## Core Technical Skills & Competencies
- **Core Stack (Marquee):** Node.js, NestJS, TypeScript, PostgreSQL, Redis, RabbitMQ, Docker, Kubernetes, AWS, React.
- **Generative AI & Agentic Systems:** Custom AI agents, autonomous workflow orchestration, prompt engineering, LangChain, LangGraph, vector databases (Pinecone, Chroma, pgvector), RAG (Retrieval-Augmented Generation) architecture, LLM API integrations (Gemini, OpenAI, Anthropic Claude).
- **Backend Architecture & APIs:** Node.js, NestJS, Express.js, TypeScript, RESTful API design, Microservices Architecture, WebSockets, Socket.IO, JWT authentication, distributed systems, event-driven architecture.
- **Databases & Data Modeling:** PostgreSQL, MongoDB, Redis caching & pub/sub, Prisma ORM, TypeORM, raw SQL query optimization, database indexing, transaction management.
- **Messaging & Event Pipelines:** RabbitMQ (asynchronous message queuing, dead-letter queues, automated retry backoff), Redis Pub/Sub, Socket.IO real-time event distribution.
- **Third-Party Integrations:** Razorpay payment gateway, Twilio, Cloudinary, Nodemailer.
- **DevOps, Cloud & Infrastructure:** Docker, Docker Compose, Kubernetes, AWS (EC2, ECS, S3, RDS), Oracle Cloud Infrastructure (OCI VMs), Azure DevOps, Linux administration, Nginx reverse proxy, PM2 process management, GitHub Actions CI/CD pipelines, Cloudflare.
- **Frontend Development:** React.js, Redux Toolkit, TypeScript, JavaScript (ES6+), Lit (Web Components), Framer Motion, modern responsive CSS, web performance optimization.
- **Engineering Tools & Methodologies:** Git, Postman, Linux CLI, Agile/Scrum, Metabase, OWASP security best practices.

---

## Professional Experience

### Software Development Engineer - I (SDE-I) — Neutrinos
- **Period:** March 2024 – March 2026 (2 Years)
- **Domain:** Enterprise Backend & Cloud Engineering
- **Production Ownership & Responsibilities:**
  - **Sunlife Philippines Project Ownership:** Owned the Sunlife Philippines enterprise account end-to-end, spanning presales proof-of-concept, architectural alignment with the client engineering team, and production rollout.
  - **High-Throughput Decision Engine:** Architected and developed a core decision engine processing 1,000 to 2,000 requests per minute for automated insurance scheduling and policy workflows using jBPM-based business process orchestration and REST APIs.
  - **Microservices & Web Components:** Built scalable backend services for automated underwriting, policy generation, and customer communications, integrated into low-code frontend platforms through reusable Lit web components.
  - **Dynamic Claims Rendering:** Engineered dynamically rendered insurance claims forms in React using conditional field generation algorithms, reducing manual configuration cycles for new claim types.
  - **Zero-Downtime Cloud Migrations:** Coordinated and executed Kubernetes-based production migrations alongside DevOps, organizing deployment windows to achieve zero service downtime.
  - **Mentorship & Quality Standards:** Mentored 2+ junior developers on backend architecture patterns and conducted thorough pull request reviews focusing on business-logic correctness and security standards.
  - **Cross-Functional Collaboration:** Partnered closely with Product Managers, Regional Product Evangelists, and client engineering squads to convert strategic business requirements into resilient technical architectures.
- **Awards & Recognitions:**
  - *Team Player Award (April 2025)* — Recognized for outstanding cross-team collaboration and engineering support.
  - *Beyond the Call of Duty Award (November 2025)* — Honored for extraordinary dedication and ownership in delivering mission-critical enterprise milestones.

---

## Featured Engineering Projects

### 1. Domain Scanner — Real-Time Security Reconnaissance SaaS
- **Status:** Live Production SaaS ([domainscanner.vyshnavpc.com](https://domainscanner.vyshnavpc.com))
- **Tech Stack:** Node.js, Express.js, TypeScript, PostgreSQL, Redis, RabbitMQ, React, Razorpay, Docker, Oracle Cloud VM, Nginx, PM2, GitHub Actions CI/CD.
- **Overview:** A SaaS platform that audits domains and scores website security risks through automated SSL/TLS verification, open port discovery, DNS security validation, and HTTP security header compliance.
- **Key Architectural Highlights:**
  - Built asynchronous scanning pipelines with RabbitMQ (0.14ms dispatch latency), automated retry backoff, Redis caching, and PostgreSQL persistence with sub-second lookup times.
  - Implemented Single Sign-On (SSO) authentication and Role-Based Access Control (RBAC) separating administrative controls from standard tenant accounts.
  - Built tiered subscription tiers featuring daily usage caps, premium plans, request quotas, and Razorpay payment gateway integration.
  - Automated deployment pipelines on Oracle Cloud VM using Docker containers, GitHub Actions CI/CD, PM2 process management, and Nginx reverse proxy.
  - Security audit modules:
    - *SSL / TLS Encryption Check:* TLS 1.3 protocol validation, certificate authority chain checks, and cipher strength audit.
    - *Port Scanner:* Non-blocking asynchronous port scanning (ports 80, 443 open; zero exposed vulnerable endpoints).
    - *DNS & Email Security:* SPF record verification, DKIM configuration checks, and DMARC enforcement.
    - *HTTP Security Headers:* A+ rated header enforcement including CSP, X-Content-Type-Options, Referrer-Policy, and HSTS.

### 2. QStack — Distributed Task Queue & AI-Powered Q&A Platform
- **Status:** In Development
- **Tech Stack:** NestJS, TypeScript, PostgreSQL, Redis, RabbitMQ, React, Docker, Kubernetes, Gemini AI.
- **Overview:** Developer knowledge and task orchestration platform constructed as a modular monolith adhering strictly to clean architecture principles and OWASP security practices.
- **Modular Monolith + RAG Architecture Layers:**
  - **Layer 01 — Ingestion & Access Control (Client & API Gateway):** OAuth2 authentication (Google and GitHub), custom RBAC role guards, OWASP-compliant rate limiting, and React SPA client.
  - **Layer 02 — Domain Business Logic (NestJS Core Services):** Questions and answers CRUD operations, hierarchical tag categorization engine, weighted voting algorithms, nested comments, and reputation & badge reward modules.
  - **Layer 03 — Semantic Search & /ask RAG Retrieval (AI Pipeline):** Vector similarity search over embeddings; Retrieval-Augmented Generation (RAG) endpoint using Gemini AI to pull relevant Q&A context before synthesizing answers.
  - **Layer 04 — Event Bus & Persistence (Data Fabric):** RabbitMQ real-time notification broker, PostgreSQL persistence with optimized raw SQL queries, and Redis distributed caching & session storage.
  - **Infrastructure:** Containerized with Docker and configured for Kubernetes cluster deployment.

---

## Agency & Consulting Services (LixerLab)
- **Digital Agency Initiative:** [LixerLab](https://lixerlab.vyshnavpc.com/)
- **Scope:** Full-stack product delivery, high-performance backends, and AI agent implementations.
- **Specialized Services:**
  1. **Agentic AI Development:** Custom multi-agent workflows, autonomous execution loops, prompt engineering, and LLM integrations.
  2. **Backend & API Architecture:** High-throughput microservices, RESTful APIs, and secure authentication architectures.
  3. **Distributed Systems & Queues:** Asynchronous event pipelines with RabbitMQ, Redis Pub/Sub, and fault-tolerant message handling.
  4. **Database Design & Optimization:** Complex relational schema design, indexing strategies, caching layers, and raw SQL query tuning.
  5. **End-to-End Product Engineering:** Architecture design, rapid prototyping, production deployment, and maintenance.

---

## Engineering Philosophy & Principles
1. **01. Lifecycle Ownership (End-to-End Production Delivery):** From presales proof-of-concept and architecture alignment through Kubernetes deployment windows, reliable software requires owning the entire delivery pipeline, not just writing code.
2. **02. Throughput & Scale (Architecting for Real Request Volume):** Designing high-volume decision engines (1,000–2,000 req/min) means treating latency and deterministic behavior as foundational constraints through deliberate database indexing and caching.
3. **03. Decoupled Systems (Async-First Resilient Workflows):** Long-running tasks belong in message queues with automated retries, DLQs, and cache persistence, keeping user-facing endpoints responsive and isolated from heavy downstream processing.
4. **04. Code Correctness (Rigorous Review & Knowledge Sharing):** Modular architectures only succeed when teams uphold high standards for business-logic correctness, OWASP security practices, and active mentorship of new engineers.

---

## Certifications & Specialized Training
- **Namaste Node.js** — Issued by Akshay Saini *(Verified Course)*
- **Namaste JavaScript** — Issued by Akshay Saini *(Verified Course)*
- **Learn DevOps: Docker, Kubernetes, Terraform & Azure DevOps** — Issued by Udemy *(Verified Course)*
- **Claude Code in Action** — Specialized Training
- **AWS Certified Solutions Architect** — Amazon Web Services
- **Meta Backend Developer Professional Certificate** — Meta
- **Postman API Fundamentals Student Expert** — Postman

---

## Education & Academic Foundation
- **Full Stack Development Bootcamp (MERN Stack)**  
  *Institution:* Brototype  
  *Period:* December 2022 – November 2023
- **Diploma in Graphic Design**  
  *Institution:* Sree Sankaracharya Institute  
  *Period:* December 2018 – November 2020

---

## Languages
- **English:** Fluent (Professional working proficiency)
- **Malayalam:** Native proficiency

---

## Scheduling, Consultation & Contact Policy
- **AI Assistant Representation:** Yoho is Vyshnav P C's personal portfolio AI assistant authorized to provide verified factual information and facilitate scheduling enquiries.
- **Meeting & Enquiry Policy:** Anyone seeking to discuss freelance projects, full-time backend/AI roles, consultations, or technical collaborations can request a meeting through Yoho.
- **Required Details:** Users must provide their `name`, `email`, `phone`, and `reason for getting in touch`.
- **OTP Email Verification:** To prevent spam, the user's email address must be verified using a 6-digit one-time password (OTP) sent to their email.
- **Response Commitment:** Once verified and scheduled, Vyshnav personally reviews the details and replies within 24 hours.

---

*Scraped & Compiled from [https://portfolio.vyshnavpc.com/](https://portfolio.vyshnavpc.com/) on November 14, 2026.*
