import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { config } from '../config/index.js';
import { AgentStateType, LeadInfo } from './state.js';
import { loadProfileData } from '../services/profileLoader.js';
import { RetrievedDocument } from '../services/pineconeService.js';
import {
  sendVerificationOtpTool,
  verifyOtpTool,
  scheduleEnquiryTool,
} from '../tools/index.js';

/**
 * Creates the LLM ChatOpenAI instance (Google Gemini, Groq, NVIDIA NIM, or OpenRouter)
 */
export function getLlmModel(temperature = 0) {
  const isOpenRouter = config.llm.provider === 'openrouter';
  return new ChatOpenAI({
    modelName: config.llm.model,
    apiKey: config.llm.apiKey || 'mock-key',
    configuration: {
      baseURL: config.llm.baseUrl,
      defaultHeaders: isOpenRouter
        ? {
            'HTTP-Referer': config.openrouter.siteUrl,
            'X-Title': config.openrouter.appName,
          }
        : undefined,
    },
    temperature,
    maxTokens: 2048,
    maxRetries: 3,
  });
}

export const getOpenRouterModel = getLlmModel;

function parseToolOutput(res: any): any {
  const str =
    typeof res === 'string'
      ? res
      : typeof res?.content === 'string'
      ? res.content
      : JSON.stringify(res);
  try {
    return JSON.parse(str);
  } catch {
    return { status: 'error', message: str };
  }
}

function getLastUserMessage(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage || messages[i]._getType() === 'human') {
      return typeof messages[i].content === 'string'
        ? (messages[i].content as string)
        : JSON.stringify(messages[i].content);
    }
  }
  return '';
}

function formatRecentHistory(messages: BaseMessage[], limit = 4): string {
  const recent = messages.slice(-limit);
  return recent
    .map((m) => {
      const type = m._getType() === 'human' || m instanceof HumanMessage ? 'User' : 'Assistant';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `${type}: ${content}`;
    })
    .join('\n');
}

const canonicalCategoryMap: Record<string, string> = {
  personal: 'personal',
  about: 'personal',
  bio: 'personal',
  me: 'personal',
  intro: 'personal',
  contact: 'contact',
  social: 'contact',
  links: 'contact',
  email: 'contact',
  phone: 'contact',
  reach: 'contact',
  skills: 'skills',
  tech: 'skills',
  stack: 'skills',
  technologies: 'skills',
  tools: 'skills',
  experience: 'experience',
  work: 'experience',
  job: 'experience',
  career: 'experience',
  employment: 'experience',
  history: 'experience',
  neutrinos: 'experience',
  projects: 'projects',
  project: 'projects',
  portfolio: 'projects',
  work_samples: 'projects',
  domain_scanner: 'projects',
  domainscanner: 'projects',
  yohoaiagent: 'projects',
  yoho: 'projects',
  agency: 'agency',
  lixerlab: 'agency',
  services: 'agency',
  company: 'agency',
  engineeringphilosophy: 'engineeringPhilosophy',
  philosophy: 'engineeringPhilosophy',
  principles: 'engineeringPhilosophy',
  engineering_philosophy: 'engineeringPhilosophy',
  certifications: 'certifications',
  certificates: 'certifications',
  courses: 'certifications',
  education: 'education',
  college: 'education',
  degree: 'education',
  bootcamp: 'education',
  brototype: 'education',
  languages: 'languages',
  language: 'languages',
  schedulingpolicy: 'schedulingPolicy',
  scheduling_policy: 'schedulingPolicy',
  policy: 'schedulingPolicy',
  meeting_policy: 'schedulingPolicy',
  booking_policy: 'schedulingPolicy',
};

/**
 * Phase 1: Router, Natural Language Extractor & UI Handler (AI Call 1)
 *
 * The AI receives the user's freeform text and extracts any contact details,
 * OTP codes, and intent directly into structured JSON.
 *
 * If it is an informal greeting, general talk, or UI event (contact/OTP/booking),
 * it completes immediately in this phase to prevent downstream AI calls and save tokens.
 *
 * If it is a factual question about Vyshnav's profile, it outputs the target keys
 * from profile.json for in-memory slicing in Phase 2.
 */
export async function firstRouterAndUiNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const lastMessage = getLastUserMessage(state.messages);


    const transcript = state.messages
      .map(
        (m) =>
          `${m._getType() === 'human' ? 'User' : 'Assistant'}: ${
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          }`
      )
      .join('\n');

    const routerSchema = z.object({
      isUiOrDirect: z
        .boolean()
        .describe(
          "True if user message is an informal greeting, general conversation, or a UI/scheduling/contact event (booking, providing contact info, verifying OTP). False if asking factual questions about Vyshnav's background, education, skills, projects, experience, etc."
        ),
      action: z
        .enum(['none', 'send_otp', 'verify_otp', 'schedule', 'request_info'])
        .describe(
          "Action to take: 'send_otp' if both email and name are known and OTP needs to be sent; 'verify_otp' if a 6-digit verification code is provided; 'schedule' if all info is verified and ready to book; 'request_info' if user wants to connect but name or email is missing; 'none' for greetings or profile knowledge queries."
        ),
      reply: z
        .string()
        .describe(
          "When isUiOrDirect is true, provide the complete friendly reply to the user as Yoho. (e.g. asking for missing name, greeting them, or giving confirmation). Empty string if isUiOrDirect is false."
        ),
      extracted: z
        .object({
          name: z.string().nullable().describe('Extracted user full name from user text or previous context, or null'),
          email: z.string().nullable().describe('Extracted user email from user text or previous context, or null'),
          phone: z.string().nullable().describe('Extracted phone number from user text or previous context, or null'),
          reason: z.string().nullable().describe('Extracted reason for meeting/consultation from user text, or null'),
          otp: z.string().nullable().describe('Extracted 6-digit OTP verification code from user text, or null'),
        })
        .describe('Extracted user fields parsed directly by the AI from natural language text'),
      categories: z
        .array(z.string())
        .describe(
          "List of category keys from profile.json when isUiOrDirect is false. Available keys: ['personal', 'contact', 'skills', 'experience', 'projects', 'agency', 'engineeringPhilosophy', 'certifications', 'education', 'languages', 'schedulingPolicy']."
        ),
      resolvedQuestion: z
        .string()
        .nullable()
        .describe(
          'The user question resolved with explicit subjects using the conversation history (e.g., rewriting pronouns like "it", "they", "that project" into the specific project name such as "What technologies does Domain Scanner use?").'
        ),
    });

    const llm = getOpenRouterModel(0);
    const structuredLlm = llm.withStructuredOutput(routerSchema);

    const systemPrompt = `You are AI Agent 1 (Classifier, Natural Language Extractor & UI Handler) for Vyshnav P C's personal portfolio assistant (Yoho).
Your role:
1. Read the user's natural language input and extract all user details (name, email, phone, reason, 6-digit OTP) into the "extracted" object.
   - If prior context already has their name or email, preserve it.
2. Determine if the message is:
   A) An opening greeting ("hi", "hello", "hey", "who are you"):
      isUiOrDirect: true, action: "none", reply: friendly opening greeting introducing yourself as Yoho.
   B) Mid-conversation acknowledgements or casual follow-ups ("okay", "ok", "cool", "thanks", "got it", "sure", "alright", "great"):
      - DO NOT re-introduce yourself or repeat "Hey there! I'm Yoho".
      - Instead, acknowledge naturally and contextually (e.g. "Sounds good! What would you like to explore next about Vyshnav's projects, tech stack, or would you like to schedule a consultation?").
      - isUiOrDirect: true, action: "none".
   C) A request to connect, meet, schedule, or consultation:
      - If user provides email but Name is missing:
        isUiOrDirect: true, action: "request_info", reply: ask politely for their name before dispatching the code, mentioning Vyshnav replies within 24 hours.
      - If BOTH Name and Email are available:
        isUiOrDirect: true, action: "send_otp".
      - After email verification, collect any missing name, email, phone and reason; use action: "schedule" when these are available.
      - If user entered a 6-digit OTP code:
        isUiOrDirect: true, action: "verify_otp".
      - If Name or Email is missing entirely:
        isUiOrDirect: true, action: "request_info", reply: invite them to share their Name and Email address, mentioning that Vyshnav personally replies within 24 hours.
   D) A factual question about Vyshnav P C (skills, projects, work experience, education, certifications):
      isUiOrDirect: false, action: "none", categories: matching keys from profile.json (e.g. ["education"], ["skills", "experience"], ["projects"]). Questions about specific projects (Domain Scanner, YohoAiAgent, etc.) must include "projects".
3. In resolvedQuestion, rewrite the user query to make the subject explicit using prior conversation context (e.g., resolving "What technologies does it use?" into "What technologies does Domain Scanner use?").`;

    const result = await structuredLlm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(
        `CONVERSATION TRANSCRIPT:\n${transcript}\n\nEXISTING LEAD INFO:\n${JSON.stringify(
          state.leadInfo || {}
        )}\n\nLATEST USER QUERY:\n${lastMessage}`
      ),
    ]);

    if (result.isUiOrDirect) {
      const mergedLeadInfo: LeadInfo = {
        ...state.leadInfo,
        ...(result.extracted?.name ? { name: result.extracted.name } : {}),
        ...(result.extracted?.email ? { email: result.extracted.email } : {}),
        ...(result.extracted?.phone ? { phone: result.extracted.phone } : {}),
        ...(result.extracted?.reason ? { reason: result.extracted.reason } : {}),
      };

      let isVerified = state.isVerified && mergedLeadInfo.email === state.leadInfo.email;

      // 1. Verify OTP
      if (result.action === 'verify_otp' && result.extracted?.otp) {
        const emailToVerify = mergedLeadInfo.email;
        if (!emailToVerify?.trim()) {
          return {
            intent: 'schedule_enquiry',
            leadInfo: mergedLeadInfo,
            isVerified: false,
            messages: [new AIMessage('Please share your email address so I can verify your code.')],
            uiAction: null,
          };
        }
        const verifyRes = await verifyOtpTool.invoke({
          email: emailToVerify,
          otp: result.extracted.otp,
        });
        const parsed = parseToolOutput(verifyRes);

        if (parsed.status !== 'verified') {
          const replyMsg = `Verification failed: ${parsed.message || 'Invalid code.'} Please check your 6-digit code and try again.`;
          return {
            intent: 'schedule_enquiry',
            leadInfo: mergedLeadInfo,
            messages: [new AIMessage(replyMsg)],
            uiAction: parsed.uiAction ?? null,
          };
        }

        isVerified = true;
      }

      // Continue collecting details after verification, including on later turns.
      if (result.action === 'schedule' ||
          (result.action === 'verify_otp' && isVerified) ||
          (isVerified && ['send_otp', 'request_info'].includes(result.action))) {
        const requiredFields = ['name', 'email', 'phone', 'reason'] as const;
        const missing = requiredFields.filter((field) => !mergedLeadInfo[field]?.trim());
        if (missing.length > 0) {
          return {
            intent: 'schedule_enquiry',
            leadInfo: mergedLeadInfo,
            isVerified,
            messages: [new AIMessage(`To complete your enquiry, please share your ${missing.join(', ')}.`)],
            uiAction: null,
          };
        }

        const scheduleRes = await scheduleEnquiryTool.invoke({
          name: mergedLeadInfo.name!,
          email: mergedLeadInfo.email!,
          phone: mergedLeadInfo.phone!,
          reason: mergedLeadInfo.reason!,
        });
        const scheduleParsed = parseToolOutput(scheduleRes);

        if (scheduleParsed.status === 'confirmed') {
          const replyMsg = `${result.action === 'verify_otp' ? 'Your email has been successfully verified! ' : ''}Your consultation is confirmed! ✅ Vyshnav will review your details and personally get in touch within 24 hours. 🚀`;
          return {
            intent: 'schedule_enquiry',
            leadInfo: mergedLeadInfo,
            isVerified: true,
            messages: [new AIMessage(replyMsg)],
            uiAction: null,
          };
        } else if (scheduleParsed.status === 'unverified') {
          const otpRes = await sendVerificationOtpTool.invoke({
            email: mergedLeadInfo.email!,
            name: mergedLeadInfo.name!,
          });
          const otpParsed = parseToolOutput(otpRes);
          const isSent = otpParsed.status === 'sent';
          const replyMsg = isSent
            ? `A 6-digit verification code has been dispatched to ${mergedLeadInfo.email}! 🔐 Please enter the code here to confirm your request. Vyshnav personally replies within 24 hours!`
            : `We encountered an issue sending the verification code to ${mergedLeadInfo.email}: ${otpParsed.message || 'Delivery error'}. Please try again.`;
          return {
            intent: 'schedule_enquiry',
            leadInfo: mergedLeadInfo,
            messages: [new AIMessage(replyMsg)],
            uiAction: otpParsed.uiAction ?? null,
          };
        } else {
          return {
            intent: 'schedule_enquiry',
            leadInfo: mergedLeadInfo,
            isVerified,
            messages: [new AIMessage(`Could not complete your enquiry: ${scheduleParsed.message || 'Please try again.'}`)],
            uiAction: null,
          };
        }
      }

      // 3. Send OTP (only when both name and email are present)
      if (result.action === 'send_otp' && mergedLeadInfo.email && mergedLeadInfo.name) {
        const otpRes = await sendVerificationOtpTool.invoke({
          email: mergedLeadInfo.email,
          name: mergedLeadInfo.name,
        });
        const parsed = parseToolOutput(otpRes);
        const isSuccess = parsed.status === 'sent';
        const replyMsg = isSuccess
          ? `A 6-digit verification code has been dispatched to ${mergedLeadInfo.email}! 🔐 Please enter the 6-digit verification code here to confirm your request. Vyshnav personally replies within 24 hours!`
          : `We encountered an issue sending the verification code to ${mergedLeadInfo.email}: ${parsed.message || 'Delivery failed'}. Please check your email address and try again.`;

        return {
          intent: 'schedule_enquiry',
          leadInfo: mergedLeadInfo,
          messages: [new AIMessage(replyMsg)],
          uiAction: parsed.uiAction ?? null,
        };
      }

      // 4. Request info or greeting response
      let finalReply =
        result.reply ||
        "I'd love to help you connect with Vyshnav! Please share your Name and Email address so I can send an OTP to verify your request.";
      if (result.action === 'request_info' && !finalReply.toLowerCase().includes('24 hours')) {
        finalReply += ' Vyshnav personally reviews all requests and replies within 24 hours! 🚀';
      }

      return {
        intent: result.action === 'none' ? 'general_chat' : 'schedule_enquiry',
        leadInfo: mergedLeadInfo,
        messages: [new AIMessage(finalReply)],
      };
    }

  // Knowledge query: passes category keys and resolved question to Phase 2
  return {
    intent: 'profile_query',
    categories:
      result.categories && result.categories.length > 0 ? result.categories : ['personal', 'skills'],
    extractedKeywords: result.resolvedQuestion || lastMessage,
  };
}

/**
 * Phase 2: In-Memory Data Slicing & Fact Extraction (AI Call 2)
 *
 * Loops through the category keys returned by Phase 1 and extracts ONLY those
 * sections from profile.json.
 *
 * Sends user question + sliced data to AI Call 2 to strictly extract relevant facts.
 */
export async function secondExtractorNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const lastUserQuery = getLastUserMessage(state.messages);
  const resolvedQuery = state.extractedKeywords || lastUserQuery;
  const conversationContext = formatRecentHistory(state.messages);
  const categories =
    state.categories && state.categories.length > 0 ? state.categories : ['personal', 'skills'];

  // In-Memory Slicing from profile.json (0 AI tokens spent on slicing)
  const profile = loadProfileData();
  const slicedData: Record<string, any> = {};

  for (const cat of categories) {
    const normalized = cat.toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
    const canonicalKey = canonicalCategoryMap[normalized] || (cat.toLowerCase().trim() === 'about' ? 'personal' : cat.trim());
    if ((profile as any)[canonicalKey]) {
      slicedData[canonicalKey] = (profile as any)[canonicalKey];
    }
  }

  // If a category cannot be resolved, recover before invoking the extractor rather than passing an empty slice
  if (Object.keys(slicedData).length === 0) {
    slicedData.personal = profile.personal;
    slicedData.skills = profile.skills;
    slicedData.projects = profile.projects;
  }

  // Keep the complete projects slice available to both extraction and generation stages
  if (!slicedData.projects && profile.projects) {
    slicedData.projects = profile.projects;
  }

  // Synthesize retrievedDocs from sliced keys for test compatibility
  const retrievedDocs: RetrievedDocument[] = Object.entries(slicedData).map(([k, v], i) => ({
    id: `slice-${k}`,
    score: 0.95 - i * 0.05,
    text: typeof v === 'string' ? v : JSON.stringify(v, null, 2),
    metadata: { category: k },
  }));

  const extractorSchema = z.object({
    relevantFacts: z
      .array(z.string())
      .describe(
        'List of precise, factual bullet points strictly answering the user query from the provided JSON slice.'
      ),
    found: z.boolean().describe('True if relevant data was found in the sliced JSON; false otherwise.'),
  });

  const llm = getOpenRouterModel(0);
  const structuredLlm = llm.withStructuredOutput(extractorSchema);

  const systemPrompt = `You are AI Agent 2 (Targeted Fact Extractor) for Vyshnav P C's portfolio.
You are given conversation context, the resolved user question, and a filtered slice of profile.json.
Your job is to read the provided JSON slice and extract ONLY the facts that directly answer the user's question, preserving any subject or context from previous turns.
Return strict JSON with relevantFacts and found.`;

  const result = await structuredLlm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `RECENT CONVERSATION CONTEXT:\n${conversationContext}\n\nUSER QUESTION (RESOLVED):\n"${resolvedQuery}"\n\nSLICED PROFILE DATA (JSON):\n${JSON.stringify(slicedData, null, 2)}`
    ),
  ]);

  return {
    slicedData,
    relevantFacts: result.relevantFacts || [],
    retrievedDocs,
    extractedKeywords: resolvedQuery,
  };
}

/**
 * Phase 3: Final Response Synthesizer (AI Call 3)
 * Synthesizes the extracted facts into a polished, natural answer from Yoho.
 */
export async function thirdGeneratorNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const lastUserQuery = getLastUserMessage(state.messages);
  const resolvedQuery = state.extractedKeywords || lastUserQuery;
  const conversationContext = formatRecentHistory(state.messages);
  const facts = state.relevantFacts || [];
  const factsText = facts.join('\n- ');

  const llm = getOpenRouterModel(0.2);

  const systemPrompt = `You are Yoho, Vyshnav P C's personal AI portfolio assistant.
Your task is to answer the user's question directly and thoroughly using ONLY the provided verified facts.

STRICT RULES:
1. ONLY use the facts provided in the input. DO NOT add any outside or additional information of your own.
2. Answer the question directly and completely. Never return only an intro or teaser—always include all relevant facts.
3. Output clean, readable plain text with standard bullet points (-) and helpful emojis (👋, 🚀, 💻, 🤖, ✨).
4. NEVER use any HTML tags under any circumstances (NO <br>, NO <table>, NO <tr>, NO <td>, NO <p>, NO <div>, NO <span>). Use normal line breaks and bullet points only.
5. DO NOT add any concluding summaries, commentary, wrap-up statements, or tips at the end (NO "Summary:", NO "Tip:", NO "This experience showcases..."). Deliver the factual answer directly and stop immediately.`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `RECENT CONVERSATION CONTEXT:\n${conversationContext}\n\nUSER QUESTION (RESOLVED):\n"${resolvedQuery}"\n\nDATA FROM AI 2 (VERIFIED FACTS):\n- ${factsText}`
    ),
  ]);

  const finalMessage = typeof response.content === 'string' ? response.content.trim() : JSON.stringify(response.content);

  return {
    finalMessage,
    messages: [new AIMessage(finalMessage)],
  };
}

// Backwards-compatibility aliases for existing imports
export const agent1KeywordExtractor = firstRouterAndUiNode;
export const agent2RelevanceClassifier = secondExtractorNode;
export const agent3ProfileSynthesizer = thirdGeneratorNode;
export const pineconeRetrievalNode = async (state: AgentStateType) => ({ retrievedDocs: state.retrievedDocs });
export const enquiryCoordinatorNode = firstRouterAndUiNode;
