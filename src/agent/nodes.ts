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
      - If user entered a 6-digit OTP code:
        isUiOrDirect: true, action: "verify_otp".
      - If Name or Email is missing entirely:
        isUiOrDirect: true, action: "request_info", reply: invite them to share their Name and Email address, mentioning that Vyshnav personally replies within 24 hours.
   D) A factual question about Vyshnav P C (skills, projects, work experience, education, certifications):
      isUiOrDirect: false, action: "none", categories: matching keys from profile.json (e.g. ["education"], ["skills", "experience"], ["projects"]). Questions about specific projects (Domain Scanner, YohoAiAgent, etc.) must include "projects".`;

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

      // 1. Verify OTP
      if (result.action === 'verify_otp' && result.extracted?.otp) {
        const emailToVerify = mergedLeadInfo.email || 'user@example.com';
        const verifyRes = await verifyOtpTool.invoke({
          email: emailToVerify,
          otp: result.extracted.otp,
        });
        const parsed = JSON.parse(verifyRes);
        const replyMsg =
          parsed.status === 'verified'
            ? `Your email has been successfully verified! ✅ Vyshnav will review your details and get in touch within 24 hours. 🚀`
            : `Verification failed: ${parsed.message} Please check your 6-digit code and try again.`;

        return {
          intent: 'schedule_enquiry',
          leadInfo: mergedLeadInfo,
          messages: [new AIMessage(replyMsg)],
          uiAction: parsed,
        };
      }

      // 2. Send OTP (only when both name and email are present)
      if (result.action === 'send_otp' && mergedLeadInfo.email && mergedLeadInfo.name) {
        const otpRes = await sendVerificationOtpTool.invoke({
          email: mergedLeadInfo.email,
          name: mergedLeadInfo.name,
        });
        const parsed = JSON.parse(otpRes);
        const replyMsg = `A 6-digit verification code has been dispatched to ${mergedLeadInfo.email}! 🔐 Please enter the 6-digit verification code here to confirm your request. Vyshnav personally replies within 24 hours!`;

        return {
          intent: 'schedule_enquiry',
          leadInfo: mergedLeadInfo,
          messages: [new AIMessage(replyMsg)],
          uiAction: parsed,
        };
      }

      // 3. Request info or greeting response
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

  // Knowledge query: passes category keys to Phase 2
  return {
    intent: 'profile_query',
    categories:
      result.categories && result.categories.length > 0 ? result.categories : ['personal', 'skills'],
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
  const userQuery = getLastUserMessage(state.messages);
  const categories =
    state.categories && state.categories.length > 0 ? state.categories : ['personal', 'skills'];

  // In-Memory Slicing from profile.json (0 AI tokens spent on slicing)
  const profile = loadProfileData();
  const slicedData: Record<string, any> = {};

  for (const cat of categories) {
    const key = cat.toLowerCase().trim() === 'about' ? 'personal' : cat.trim();
    if ((profile as any)[key]) {
      slicedData[key] = (profile as any)[key];
    }
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
You are given a strictly filtered slice of profile.json corresponding to the requested categories.
Your job is to read the provided JSON slice and extract ONLY the facts that directly answer the user's question.
Return strict JSON with relevantFacts and found.`;

  const result = await structuredLlm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `USER QUESTION: "${userQuery}"\n\nSLICED PROFILE DATA (JSON):\n${JSON.stringify(slicedData, null, 2)}`
    ),
  ]);

  return {
    slicedData,
    relevantFacts: result.relevantFacts || [],
    retrievedDocs,
  };
}

/**
 * Phase 3: Final Response Synthesizer (AI Call 3)
 * Synthesizes the extracted facts into a polished, natural answer from Yoho.
 */
export async function thirdGeneratorNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const userQuery = getLastUserMessage(state.messages);
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
    new HumanMessage(`USER QUESTION: "${userQuery}"\n\nDATA FROM AI 2 (VERIFIED FACTS):\n- ${factsText}`),
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
