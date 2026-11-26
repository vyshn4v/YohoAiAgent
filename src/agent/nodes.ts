import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { ChatOpenAI } from '@langchain/openai';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { config } from '../config/index.js';
import { AgentStateType, LeadInfo } from './state.js';
import { generateTextEmbedding } from '../services/embeddingService.js';
import { searchResumeChunks } from '../services/pgVectorService.js';
import { loadProfileSections } from '../services/profileLoader.js';
import { RetrievedDocument } from '../services/pineconeService.js';
import { createNodeLogger, formatErrorDetails, NodeLogger } from '../utils/nodeLogger.js';
import {
  sendVerificationOtpTool,
  verifyOtpTool,
  scheduleEnquiryTool,
} from '../tools/index.js';

/**
 * Creates a ChatOpenAI model instance pointing to the active provider (Gemini, OpenRouter, etc.).
 */
function createModelInstance(modelName: string, temperature = 0) {
  const isGemini = config.llm.provider === 'gemini';
  const apiKey = isGemini ? config.gemini.apiKey : config.llm.apiKey;
  const baseUrl = isGemini ? config.gemini.baseUrl : config.llm.baseUrl;
  const isOpenRouter = config.llm.provider === 'openrouter';

  return new ChatOpenAI({
    modelName,
    apiKey: apiKey || 'mock-key',
    configuration: {
      baseURL: baseUrl,
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

let genAiClient: GoogleGenAI | null = null;

/** Singleton Google GenAI SDK client (used for native Decision AI / Gemini APIs) */
export function getGoogleGenAiClient(): GoogleGenAI {
  if (!genAiClient) {
    const apiKey = config.gemini.apiKey || config.llm.apiKey;
    if (!apiKey || apiKey === 'mock-key') {
      throw new Error('Gemini API key is not configured.');
    }
    genAiClient = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
  }
  return genAiClient;
}

/** 1. Greeting Small Model: gemini-flash-lite-latest (Instant greetings with zero DB retrieval) */
export function getGreetingSmallModel(temperature = 0.3) {
  return createModelInstance(config.models?.greeting || 'gemini-flash-lite-latest', temperature);
}

/** 2. Knowledge Big Model: gemini-3.5-flash-lite (Deep contextual synthesis) */
export function getKnowledgeBigModel(temperature = 0.2) {
  return createModelInstance(config.models?.big || 'gemini-3.5-flash-lite', temperature);
}

// Backward compatibility alias
export const getLlmModel = getKnowledgeBigModel;
export const getOpenRouterModel = getGreetingSmallModel;

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

/**
 * Decision Node: Calls gemini-decision-1 via official @google/genai SDK (Zero LLM)
 * If failed, returns error message to user to try again later.
 */
async function callDecisionModel(message: string): Promise<'greeting' | 'schedule_enquiry' | 'knowledge_query'> {
  const ai = getGoogleGenAiClient();
  const modelName = config.models.decision || 'gemini-decision-1';

  const response = await ai.decisions.create({
    model: modelName,
    input: message,
    questions: {
      intent: {
        type: 'choice',
        instructions: 'Classify the user message intent.',
        criteria: {
          greeting: 'Casual greeting or pleasantry like hi, hello, hey',
          schedule_enquiry:
            'Scheduling or requesting a meeting/consultation, sharing contact details, or entering an OTP code',
          knowledge_query:
            'Questions about Vyshnav skills, experience, projects, education, or resume',
        },
      },
    },
  });

  const intentAnswer = response?.answers?.intent;
  const choice = intentAnswer?.type === 'choice' ? intentAnswer.choice : undefined;
  if (choice !== 'greeting' && choice !== 'schedule_enquiry' && choice !== 'knowledge_query') {
    throw new Error('Decision model returned invalid response');
  }

  return choice;
}

export async function decisionRouterNode(
  state: AgentStateType,
  runConfig?: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const lastMessage = getLastUserMessage(state.messages);
  const modelName = config.models.decision || 'gemini-decision-1';
  const log = createNodeLogger('DecisionRouter', runConfig);
  log.start({
    model: modelName,
    messageLen: lastMessage.length,
    historyCount: state.messages.length,
  });

  try {
    const intent = await callDecisionModel(lastMessage);
    const mappedIntent = intent === 'knowledge_query' ? 'profile_query' : intent;
    const nextNode =
      mappedIntent === 'greeting'
        ? 'greeting_small_model'
        : mappedIntent === 'schedule_enquiry'
        ? 'schedule_enquiry'
        : 'pgvector_retriever';

    log.done({ intent: mappedIntent, rawChoice: intent, nextNode });
    return {
      intent: mappedIntent,
      extractedKeywords: lastMessage,
    };
  } catch (err: any) {
    log.fail(err, { step: 'call_decision_model', model: modelName, fallbackIntent: 'direct' });
    const errorMessage = 'An error occurred while processing your request. Please try again later.';
    return {
      intent: 'direct',
      finalMessage: errorMessage,
      messages: [new AIMessage(errorMessage)],
    };
  }
}

/**
 * Node: Schedule Enquiry Node
 * Dedicated Small AI Model extracts contact JSON and manages the OTP & meeting flow.
 * If failed, returns error message to user to try again later.
 */
export async function scheduleEnquiryNode(
  state: AgentStateType,
  runConfig?: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const lastMessage = getLastUserMessage(state.messages);
  const modelName = config.models?.greeting || 'gemini-flash-lite-latest';
  const log = createNodeLogger('ScheduleEnquiry', runConfig);
  let currentStep = 'init';

  log.start({
    model: modelName,
    historyCount: state.messages.length,
    isVerified: Boolean(state.isVerified),
  });

  const contactSchema = z.object({
    name: z.string().nullable().describe('User full name'),
    email: z.string().nullable().describe('User email address'),
    phone: z.string().nullable().describe('User phone number'),
    reason: z.string().nullable().describe('Reason for consultation'),
    otp: z.string().nullable().describe('6-digit OTP code'),
    action: z.enum(['verify_otp', 'schedule', 'send_otp', 'request_info']),
  });

  try {
    currentStep = 'extract_contact_fields';
    log.step('Extracting contact details and action', { model: modelName });
    const smallModel = getGreetingSmallModel(0);
    const extractor = smallModel.withStructuredOutput(contactSchema);
    const conversationContext = state.messages
      .map((m) => `${m._getType() === 'human' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n');
    const extracted = await extractor.invoke(conversationContext || lastMessage);

    const mergedLeadInfo: LeadInfo = {
      ...state.leadInfo,
      ...(extracted.name ? { name: extracted.name } : {}),
      ...(extracted.email ? { email: extracted.email } : {}),
      ...(extracted.phone ? { phone: extracted.phone } : {}),
      ...(extracted.reason ? { reason: extracted.reason } : {}),
    };

    log.step('Extracted scheduling fields', {
      action: extracted.action,
      hasName: Boolean(mergedLeadInfo.name),
      hasEmail: Boolean(mergedLeadInfo.email),
      hasPhone: Boolean(mergedLeadInfo.phone),
      hasReason: Boolean(mergedLeadInfo.reason),
      hasOtp: Boolean(extracted.otp),
    });

    // 1. Verify OTP if provided
    if (extracted.otp && (extracted.action === 'verify_otp' || !state.isVerified)) {
      currentStep = 'verify_otp_tool';
      log.step('Verifying submitted OTP', { hasLeadEmail: Boolean(mergedLeadInfo.email) });
      const emailToVerify = mergedLeadInfo.email || 'user@example.com';
      const verifyRes = await verifyOtpTool.invoke({
        email: emailToVerify,
        otp: extracted.otp,
      });
      const parsed = parseToolOutput(verifyRes);

      if (parsed.status !== 'verified') {
        log.warn('OTP verification rejected', { status: parsed.status });
        log.done({ outcome: 'otp_verification_failed' });
        const replyMsg = `Verification failed: ${parsed.message || 'Invalid code.'} Please check your code and try again.`;
        return {
          intent: 'schedule_enquiry',
          leadInfo: mergedLeadInfo,
          messages: [new AIMessage(replyMsg)],
          uiAction: parsed.uiAction ?? null,
        };
      }

      if (!mergedLeadInfo.name) {
        log.done({ outcome: 'otp_verified_missing_name', isVerified: true });
        return {
          intent: 'schedule_enquiry',
          leadInfo: mergedLeadInfo,
          isVerified: true,
          messages: [new AIMessage('Your email has been successfully verified! ✅ Please share your full name to finalize the booking.')],
          uiAction: null,
        };
      }

      currentStep = 'schedule_enquiry_after_otp';
      log.step('OTP verified; finalizing enquiry booking');
      const scheduleRes = await scheduleEnquiryTool.invoke({
        name: mergedLeadInfo.name,
        email: emailToVerify,
        phone: mergedLeadInfo.phone || 'Not provided',
        reason: mergedLeadInfo.reason || 'General portfolio consultation / enquiry',
      });
      const scheduleParsed = parseToolOutput(scheduleRes);

      if (scheduleParsed.status !== 'confirmed') {
        log.warn('Enquiry booking after OTP did not confirm', { status: scheduleParsed.status });
      }
      log.done({
        outcome: scheduleParsed.status === 'confirmed' ? 'booking_confirmed' : 'booking_failed',
        status: scheduleParsed.status,
        isVerified: true,
      });

      const replyMsg =
        scheduleParsed.status === 'confirmed'
          ? 'Your email has been successfully verified! ✅ Vyshnav will review your details and reach out within 24 hours.'
          : `Unable to finalize consultation: ${scheduleParsed.message || 'Please try again later.'}`;

      return {
        intent: 'schedule_enquiry',
        leadInfo: mergedLeadInfo,
        isVerified: true,
        messages: [new AIMessage(replyMsg)],
        uiAction: null,
      };
    }

    // 2. Require both name and email before dispatching OTP or scheduling
    if (!mergedLeadInfo.name || !mergedLeadInfo.email) {
      log.done({
        outcome: 'missing_required_fields',
        hasName: Boolean(mergedLeadInfo.name),
        hasEmail: Boolean(mergedLeadInfo.email),
      });
      const replyMsg = !mergedLeadInfo.name && !mergedLeadInfo.email
        ? 'Please share your name and email address to schedule a consultation. Vyshnav reviews all requests within 24 hours.'
        : !mergedLeadInfo.name
        ? 'Could you please share your name as well? Vyshnav personally replies within 24 hours.'
        : 'Please share your email address so I can send a verification code.';

      return {
        intent: 'schedule_enquiry',
        leadInfo: mergedLeadInfo,
        messages: [new AIMessage(replyMsg)],
        uiAction: null,
      };
    }

    // 3. Name and email available: attempt scheduling or dispatch verification OTP if unverified
    currentStep = 'schedule_enquiry_tool';
    log.step('Checking verification and scheduling enquiry');
    const scheduleRes = await scheduleEnquiryTool.invoke({
      name: mergedLeadInfo.name,
      email: mergedLeadInfo.email,
      phone: mergedLeadInfo.phone || 'Not provided',
      reason: mergedLeadInfo.reason || 'General consultation',
    });
    const scheduleParsed = parseToolOutput(scheduleRes);

    if (scheduleParsed.status === 'confirmed') {
      log.done({ outcome: 'booking_confirmed', isVerified: true });
      return {
        intent: 'schedule_enquiry',
        leadInfo: mergedLeadInfo,
        isVerified: true,
        messages: [new AIMessage('Your consultation is confirmed! ✅ Vyshnav will review your details and reach out within 24 hours.')],
        uiAction: null,
      };
    }

    if (scheduleParsed.status === 'unverified') {
      currentStep = 'send_verification_otp_tool';
      log.step('Email unverified; dispatching verification OTP');
      const otpRes = await sendVerificationOtpTool.invoke({
        email: mergedLeadInfo.email,
        name: mergedLeadInfo.name,
      });
      const otpParsed = parseToolOutput(otpRes);
      const isSent = otpParsed.status === 'sent';
      if (!isSent) {
        log.warn('Verification OTP dispatch failed', { status: otpParsed.status });
      }
      log.done({ outcome: isSent ? 'otp_dispatched' : 'otp_dispatch_failed', status: otpParsed.status });
      const replyMsg = isSent
        ? `A 6-digit verification code has been dispatched to ${mergedLeadInfo.email}! 🔐 Please enter the code here to confirm. Vyshnav personally replies within 24 hours!`
        : `Failed to send verification code to ${mergedLeadInfo.email}. Please try again later.`;

      return {
        intent: 'schedule_enquiry',
        leadInfo: mergedLeadInfo,
        messages: [new AIMessage(replyMsg)],
        uiAction: otpParsed.uiAction ?? null,
      };
    }

    log.warn('schedule_enquiry returned unexpected status', { status: scheduleParsed.status });
    log.done({ outcome: 'booking_not_confirmed', status: scheduleParsed.status });
    return {
      intent: 'schedule_enquiry',
      leadInfo: mergedLeadInfo,
      messages: [new AIMessage(`Unable to finalize consultation: ${scheduleParsed.message || 'Please try again later.'}`)],
      uiAction: null,
    };
  } catch (err: any) {
    log.fail(err, { step: currentStep, model: modelName });
    const errorMessage = 'An error occurred while processing your scheduling request. Please try again later.';
    return {
      intent: 'schedule_enquiry',
      finalMessage: errorMessage,
      messages: [new AIMessage(errorMessage)],
    };
  }
}

async function invokeModelWith404Fallback(
  model: ChatOpenAI,
  fallbackModelName: string,
  temperature: number,
  messages: BaseMessage[],
  log?: NodeLogger
) {
  try {
    return await model.invoke(messages);
  } catch (err: any) {
    if (err?.status === 404 || err?.lc_error_code === 'MODEL_NOT_FOUND') {
      log?.warn('Primary model returned 404/MODEL_NOT_FOUND; falling back', {
        fallbackModel: fallbackModelName,
      });
      const fallback = createModelInstance(fallbackModelName, temperature);
      return await fallback.invoke(messages);
    }
    throw err;
  }
}

/**
 * Node 2: Greeting Node (Small Model: gemini-flash-lite-latest)
 * Sends back an instant, friendly greeting with ZERO database lookup.
 */
export async function greetingSmallModelNode(
  state: AgentStateType,
  runConfig?: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const lastMessage = getLastUserMessage(state.messages);
  const modelName = config.models?.greeting || 'gemini-flash-lite-latest';
  const log = createNodeLogger('GreetingNode', runConfig);
  log.start({ model: modelName, messageLen: lastMessage.length });

  const greetingSystemPrompt = `You are Yoho, the AI portfolio assistant for Vyshnav P C (Full-Stack & AI Engineer).
Reply warmly in 1-2 short sentences; mention you can share Vyshnav's skills, projects, experience, or help schedule a meeting.`;

  try {
    const response = await invokeModelWith404Fallback(
      getGreetingSmallModel(0.3),
      'gemini-flash-latest',
      0.3,
      [new SystemMessage(greetingSystemPrompt), new HumanMessage(lastMessage || 'Hello')],
      log
    );

    const replyText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    log.done({ replyLen: replyText.length });

    return {
      finalMessage: replyText,
      messages: [new AIMessage(replyText)],
      uiAction: null,
    };
  } catch (err: any) {
    log.fail(err, { step: 'llm_invoke', model: modelName });
    throw err;
  }
}

/**
 * Node 3: PostgreSQL Vector Retriever Node
 * Embeds query keywords using gemini-embedding-2 and retrieves top matching chunks from pgvector.
 */
export async function pgVectorRetrieverNode(
  state: AgentStateType,
  runConfig?: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const query = state.extractedKeywords || getLastUserMessage(state.messages);
  const embeddingModel = config.models.embedding || 'gemini-embedding-2';
  const log = createNodeLogger('PgVectorRetriever', runConfig);
  log.start({
    queryLen: query.length,
    querySource: state.extractedKeywords ? 'extractedKeywords' : 'lastMessage',
  });

  let retrievedDocs: RetrievedDocument[] = [];
  let docSource: 'pgvector' | 'local_fallback' | 'empty' = 'empty';

  try {
    // Generate query embedding via gemini-embedding-2
    log.step('Generating embedding and querying pgvector', { embeddingModel, topK: 4 });
    const queryEmbedding = await generateTextEmbedding(query);

    // Query PostgreSQL resume_chunks table via cosine distance
    const pgChunks = await searchResumeChunks(queryEmbedding, 4);

    if (pgChunks && pgChunks.length > 0) {
      retrievedDocs = pgChunks.map((c) => ({
        id: c.id,
        score: c.similarity ?? 0.85,
        text: `### ${c.title}\n${c.content}`,
        metadata: c.metadata,
      }));
      docSource = 'pgvector';
      log.step('pgvector search returned matches', { count: retrievedDocs.length });
    } else {
      log.warn('pgvector returned 0 chunks; falling back to local profile sections');
    }
  } catch (err: any) {
    log.warn('Vector search exception; falling back to local profile sections', {
      error: formatErrorDetails(err),
    });
  }

  // Exception handling fallback (Rule 3): if PostgreSQL has no chunks or is offline,
  // seamlessly fall back to local profile sections so queries never fail!
  if (retrievedDocs.length === 0) {
    try {
      const sections = loadProfileSections();
      const queryLower = query.toLowerCase();
      const scored = sections.map((sec, idx) => {
        let score = 0.4;
        const terms = queryLower.split(/\s+/).filter((t) => t.length > 2);
        for (const term of terms) {
          if (sec.text.toLowerCase().includes(term)) score += 0.2;
        }
        return {
          id: sec.id || `chunk-fallback-${idx}`,
          score: Math.min(score, 0.95),
          text: `### ${sec.title}\n${sec.text.trim()}`,
          metadata: sec.metadata || {},
        };
      });
      scored.sort((a, b) => b.score - a.score);
      retrievedDocs = scored.slice(0, 4);
      docSource = retrievedDocs.length > 0 ? 'local_fallback' : 'empty';
      log.step('Local profile fallback completed', {
        sectionsScanned: sections.length,
        docsSelected: retrievedDocs.length,
      });
    } catch (fallbackErr: any) {
      log.fail(fallbackErr, { step: 'local_profile_fallback', docs: 0 });
    }
  }

  log.done({ source: docSource, docs: retrievedDocs.length });
  return {
    retrievedDocs,
    classifiedDocs: retrievedDocs,
  };
}

/**
 * Node 4: Knowledge Node (Big Model: gemini-3.5-flash-lite)
 * Synthesizes grounded, accurate, professional answers as Yoho using the retrieved chunks.
 */
export async function bigModelKnowledgeNode(
  state: AgentStateType,
  runConfig?: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const lastMessage = getLastUserMessage(state.messages);
  const modelName = config.models?.big || 'gemini-3.5-flash-lite';
  const docsCount = state.retrievedDocs?.length || 0;
  const log = createNodeLogger('KnowledgeNode', runConfig);
  log.start({ model: modelName, docs: docsCount, messageLen: lastMessage.length });

  const contextText =
    (state.retrievedDocs || [])
      .map((d, i) => `[Source ${i + 1}]:\n${d.text}`)
      .join('\n\n') || 'Vyshnav P C is a Full-Stack & AI Engineer specialized in LangGraph, TypeScript, Python, and Node.js.';

  const knowledgeSystemPrompt = `You are Yoho, AI assistant for Vyshnav P C (Full-Stack & AI Engineer).
Answer concisely and professionally using ONLY the resume context below. Highlight concrete skills and results. If missing, state what is known and offer a call.

CONTEXT:
${contextText}`;

  try {
    const response = await invokeModelWith404Fallback(
      getKnowledgeBigModel(0.2),
      'gemini-flash-latest',
      0.2,
      [new SystemMessage(knowledgeSystemPrompt), new HumanMessage(lastMessage)],
      log
    );

    const replyText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    log.done({ replyLen: replyText.length, docs: docsCount });

    return {
      finalMessage: replyText,
      messages: [new AIMessage(replyText)],
      uiAction: null,
    };
  } catch (err: any) {
    log.fail(err, { step: 'llm_invoke', model: modelName, docs: docsCount });
    throw err;
  }
}

// Backward compatibility node aliases
export const firstRouterAndUiNode = decisionRouterNode;
export const secondExtractorNode = pgVectorRetrieverNode;
export const thirdGeneratorNode = bigModelKnowledgeNode;
