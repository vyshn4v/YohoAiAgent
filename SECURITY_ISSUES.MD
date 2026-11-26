# Security Vulnerability Audit

Documented in accordance with [SECURITY_INSTRUCTION.md](/docs/SECURITY_INSTRUCTION.md) (Rules 2 & 3).

## Detected Dependencies with Known Vulnerabilities

The following packages contain upstream security advisories reported by `npm audit`:

1. **`tinypool` (<=2.1.1)** - Critical
   - **Advisory:** Prototype pollution gadget leading to potential RCE (GHSA-5gmw-xhrv-c9v3 / GHSA-85c8-ppgw-ccpr).
   - **Source:** Pulled transitively via `vitest`.
   - **Recommended Action:** Update `vitest` when upgrading to Vite/Vitest v5+.

2. **`nodemailer` (<=10.1.3)** - High
   - **Advisory:** Addressparser ReDoS and SMTP command injection via CRLF (GHSA-mm7p-fcc7-pg87 / GHSA-c7w3-x93f-qmm8).
   - **Source:** Direct dependency `nodemailer@6.10.0`.
   - **Recommended Action:** Upgrade to `nodemailer@6.10.1`+ / v10 when available.

3. **`langsmith` (<=0.5.26)** - High
   - **Advisory:** Header injection SSRF and prototype pollution (GHSA-v34v-rq6j-cj6p / GHSA-fw9q-39r9-c252).
   - **Source:** Transitive dependency via `@langchain/core`.
   - **Recommended Action:** Upgrade `@langchain/core` when major release lands.

4. **`zod` (<4.6.6)** - High
   - **Advisory:** Memory exhaustion on oversized constrained collections (GHSA-mrhx-c7xc-m3w5).
   - **Source:** Dependency of `@langchain/core` and `openai`.

5. **`uuid` (<11.1.1)** - Moderate
   - **Advisory:** Missing buffer bounds check in v3/v5/v6 when buffer is provided (GHSA-w5hq-g745-h8pq).
   - **Source:** Transitive dependency via `@langchain/core`.
