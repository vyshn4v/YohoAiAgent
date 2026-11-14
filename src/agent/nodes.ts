import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { config } from '../config/index.js';
import { AgentStateType, LeadInfo } from './state.js';
import { queryPinecone, RetrievedDocument } from '../services/pineconeService.js';
import {
  requestContactDetailsTool,
  sendVerificationOtpTool,
  verifyOtpTool,
  scheduleEnquiryTool,
} from '../tools/index.js';

/**
 * Creates the OpenRouter ChatOpenAI instance
 */
export function getOpenRouterModel(temperature = 0) {
  return new ChatOpenAI({
    modelName: config.openrouter.model,
    apiKey: config.openrouter.apiKey || 'mock-key',
    configuration: {
      baseURL: config.openrouter.baseUrl,
      defaultHeaders: {
        'HTTP-Referer': config.openrouter.siteUrl,
        'X-Title': config.openrouter.appName,
      },
    },
    temperature,
    maxTokens: 1000,
  });
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
 * Agent 1: Intent & Keyword Query Extractor
 * Analyzes conversation and extracts optimal search queries for Pinecone.
 */
export async function agent1KeywordExtractor(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const lastMessage = getLastUserMessage(state.messages);

  // If no live API key is set, use intelligent heuristic extraction
  if (!config.openrouter.apiKey || config.openrouter.apiKey === 'your_openrouter_api_key_here') {
    const lower = lastMessage.toLowerCase();
    const isEnquiry =
      lower.includes('schedule') ||
      lower.includes('meet') ||
      lower.includes('contact') ||
      lower.includes('touch') ||
      lower.includes('otp') ||
      lower.includes('verify') ||
      lower.includes('call') ||
      /\b\d{6}\b/.test(lower) ||
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/.test(lower);

    if (isEnquiry) {
      return {
        intent: 'schedule_enquiry',
        extractedKeywords: '',
      };
    }

    const isGreeting =
      lower === 'hi' ||
      lower === 'hello' ||
      lower === 'hey' ||
      lower.startsWith('who are you');

    if (isGreeting) {
      return {
        intent: 'profile_query',
        extractedKeywords: 'overview background skills title Vyshnav',
      };
    }

    return {
      intent: 'profile_query',
      extractedKeywords: lastMessage,
    };
  }

  // With OpenRouter LLM: Use Structured Output Schema to guarantee 100% valid JSON and prevent chat leaks
  try {
    const transcript = state.messages
      .map(
        (m) =>
          `${m._getType() === 'human' ? 'User' : 'Assistant'}: ${
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          }`
      )
      .join('\n');

    const intentSchema = z.object({
      intent: z
        .enum(['schedule_enquiry', 'profile_query', 'general_chat'])
        .describe(
          'schedule_enquiry if user wants to connect/schedule, provides contact info (name, email, phone, reason), or provides an OTP verification code. profile_query if asking about Vyshnav profile. general_chat if greetings.'
        ),
      keywords: z
        .string()
        .describe(
          'Concise search keywords to query Pinecone if profile_query; empty string if schedule_enquiry or general_chat.'
        ),
    });

    const llm = getOpenRouterModel(0);
    const structuredLlm = llm.withStructuredOutput(intentSchema);

    const systemPrompt = `You are Agent 1 (Intent & Context Classifier) for Vyshnav P C's personal portfolio assistant (Yoho).
Your sole purpose is to analyze the conversation transcript between User and Assistant and classify the user's intent.

Classify into one of three categories:
1. "schedule_enquiry":
   - The user has ANY intention to connect, meet, get in touch, hire, talk, message, contact, or collaborate with Vyshnav.
   - The user asks how to contact, message, reach, or book a consultation/call with Vyshnav.
   - The user is providing contact details (name, email, phone, reason).
   - The user is providing or submitting a 6-digit OTP verification code (e.g. "408130", "123456").
   - If the ongoing dialogue is about connecting, scheduling, or email verification, intent is STRICTLY "schedule_enquiry".
2. "profile_query":
   - The user is asking about Vyshnav's skills, work experience, projects, tech stack, or background (without asking to connect or meet).
3. "general_chat":
   - Casual greetings (hi, hello) or questions about Yoho.`;

    const result = await structuredLlm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(
        `CONVERSATION TRANSCRIPT:\n${transcript}\n\nTask: Classify user intent and extract keywords.`
      ),
    ]);

    return {
      intent: result.intent || 'schedule_enquiry',
      extractedKeywords: result.keywords || '',
    };
  } catch (err) {
    console.warn('[Agent1] Fallback keyword extraction:', err);
    return {
      intent: 'schedule_enquiry',
      extractedKeywords: '',
    };
  }
}

/**
 * Node: Pinecone Vector Retrieval
 */
export async function pineconeRetrievalNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const lastMsg = getLastUserMessage(state.messages).trim();
  const query = (state.extractedKeywords || '').trim() || lastMsg || 'Vyshnav P C skills experience';
  const docs = await queryPinecone(query, 4);
  return {
    retrievedDocs: docs,
  };
}

/**
 * Agent 2: Document Relevance Classifier & Filter
 * Evaluates retrieved chunks from Pinecone, filters irrelevant noise, and keeps verified facts.
 */
export async function agent2RelevanceClassifier(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const userQuery = getLastUserMessage(state.messages);
  const docs = state.retrievedDocs;

  if (!docs || docs.length === 0) {
    return { classifiedDocs: [] };
  }

  if (!config.openrouter.apiKey || config.openrouter.apiKey === 'your_openrouter_api_key_here') {
    // Offline heuristic: keep documents with score > 0.4
    const filtered = docs.filter((d) => d.score >= 0.35);
    return { classifiedDocs: filtered.length > 0 ? filtered : docs.slice(0, 2) };
  }

  try {
    const llm = getOpenRouterModel(0);
    const docSummaries = docs
      .map((d, i) => `[Doc ${i + 1}] (Score: ${d.score.toFixed(2)}):\n${d.text}`)
      .join('\n\n');

    const prompt = `You are Agent 2 (Relevance Classifier).
User Query: "${userQuery}"

Retrieved documents from Pinecone:
${docSummaries}

Task:
Select the document indices (e.g. [1, 2]) that contain relevant factual details to answer the user's query about Vyshnav P C. Discard completely irrelevant chunks.
Output JSON format ONLY:
{ "relevantIndices": [1, 2] }`;

    const response = await llm.invoke([
      new SystemMessage(prompt),
      new HumanMessage('Classify relevance now.'),
    ]);

    const content = typeof response.content === 'string' ? response.content : '';
    const cleaned = content.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const indices: number[] = Array.isArray(parsed.relevantIndices) ? parsed.relevantIndices : [1];
    const filtered = indices
      .map((idx) => docs[idx - 1])
      .filter((d): d is RetrievedDocument => Boolean(d));

    return {
      classifiedDocs: filtered.length > 0 ? filtered : docs.slice(0, 2),
    };
  } catch (err) {
    console.warn('[Agent2] Fallback relevance filter:', err);
    return {
      classifiedDocs: docs.slice(0, 2),
    };
  }
}

/**
 * Agent 3: Profile Synthesizer Agent
 * Formulates responses strictly based on verified facts. No web searches allowed.
 */
export async function agent3ProfileSynthesizer(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const userQuery = getLastUserMessage(state.messages);
  const docs = state.classifiedDocs || [];

  const contextText = docs.map((d) => d.text).join('\n\n---\n\n');

  if (!config.openrouter.apiKey || config.openrouter.apiKey === 'your_openrouter_api_key_here') {
    // Fallback response generator for testing without API keys
    const answer = `Based on Vyshnav's profile:\n\n${
      docs.length > 0
        ? docs.map((d) => d.text).join('\n\n')
        : "Vyshnav P C is a Senior AI & Full-Stack Engineer specializing in LangGraph, multi-agent systems, BullMQ, Redis, and distributed backends."
    }\n\n💡 *Tip: If you'd like to schedule a consultation or meeting with Vyshnav, let me know! He will get in touch with you within 24 hours.*`;

    return {
      messages: [new AIMessage(answer)],
    };
  }

  const systemPrompt = `You are Yoho, the exclusive AI portfolio assistant for Vyshnav P C.
STRICT GUIDELINES:
1. Your name is Yoho. When introducing yourself or asked who you are, state that you are Yoho, Vyshnav P C's personal AI portfolio assistant.
2. ONLY share information about Vyshnav's career, skills, projects, experience, services, and meeting availability based ON THE PROVIDED FACTS below.
3. ABSOLUTELY NO WEB SEARCH. You do not have web access and must never claim to search the internet or answer general world knowledge / trivia outside of Vyshnav's profile.
4. If the user asks something completely outside of Vyshnav's professional background (e.g. sports, general news, recipes), politely decline and state that you are Yoho, specialized exclusively to represent Vyshnav P C.
5. If relevant, remind the user that they can schedule a meeting/consultation directly through this chat, and Vyshnav will personally get in touch within 24 hours.
6. TONE & EMOJIS: Be warm, friendly, dynamic, and engaging! Use expressive emojis naturally throughout your responses (e.g., 👋, 🚀, 💻, 🤖, ✨, 💡, 📈, 🤝) to make the chat lively and delightful.

VERIFIED FACTS ABOUT VYSHNAV P C:
${contextText || 'Vyshnav P C is a Senior AI & Full-Stack Software Engineer specializing in LangGraph, agentic workflows, and cloud backends.'}`;

  const llm = getOpenRouterModel(0.2);
  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    ...state.messages,
  ]);

  return {
    messages: [response],
  };
}

/**
 * AI Scheduling & Lead Coordination Agent
 * An autonomous AI agent with tool-calling capabilities that reasons over the conversation,
 * extracts contact details naturally, triggers email OTP verification, and finalizes bookings.
 */
export async function enquiryCoordinatorNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const tools = [
    requestContactDetailsTool,
    sendVerificationOtpTool,
    verifyOtpTool,
    scheduleEnquiryTool,
  ];
  const modelWithTools = getOpenRouterModel(0.1).bindTools(tools);

  const systemPrompt = `You are Yoho, the dedicated Scheduling & Booking AI Agent for Vyshnav P C.
Your objective is to collect details and schedule a meeting/consultation for the user.
Your name is Yoho. When greeting or introducing yourself, use your name Yoho.

AVAILABLE TOOLS & DECISION WORKFLOW:
1. When the user wants to connect or schedule a meeting, but Full Name and/or Email Address are not yet provided:
   -> You MUST IMMEDIATELY invoke the tool request_contact_details(fields: ["name", "email"]). Do NOT simply ask in text without invoking this tool!
2. When BOTH Full Name AND Email Address are known:
   -> You MUST IMMEDIATELY invoke the tool send_verification_otp(name, email).
3. When the user provides, enters, or submits their 6-digit verification code (e.g. "408130", "123456", "my code is ..."):
   -> You MUST IMMEDIATELY invoke the tool verify_otp(email, otp).
4. After verify_otp succeeds AND you have all 4 details (name, email, phone, reason):
   -> You MUST invoke the tool schedule_enquiry(name, email, phone, reason).
5. If verified but phone or reason is missing:
   -> Ask politely for the missing phone or reason.

GUIDELINES:
- In EVERY response, you MUST explicitly include this sentence: "Vyshnav will personally get in touch within 24 hours."
- Keep your tone warm, enthusiastic, and engaging with expressive emojis (👋, ✨, 📩, 🔐, 📅, 🚀, ⏱️, 🤝).`;

  const leadInfo: LeadInfo = { ...(state.leadInfo || {}) };
  const conversationMessages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    ...state.messages,
  ];

  let response: AIMessage = await modelWithTools.invoke(conversationMessages);
  let uiAction: Record<string, any> | null = null;

  let iterations = 0;
  while (response.tool_calls && response.tool_calls.length > 0 && iterations < 3) {
    iterations++;
    conversationMessages.push(response);

    for (const call of response.tool_calls) {
      console.log(`[EnquiryAgent] AI decided to call tool: ${call.name} with:`, call.args);
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) continue;

      const args = call.args as Record<string, any>;
      if (args.name) leadInfo.name = args.name;
      if (args.email) leadInfo.email = args.email;
      if (args.phone) leadInfo.phone = args.phone;
      if (args.reason) leadInfo.reason = args.reason;

      const rawResult = await (tool as any).invoke(args);
      const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;

      if (parsed.uiAction !== undefined) {
        uiAction = parsed.uiAction;
      }

      conversationMessages.push(
        new ToolMessage({
          tool_call_id: call.id || 'tool-call',
          content: typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult),
        })
      );
    }

    response = await modelWithTools.invoke(conversationMessages);
  }

  // Guarantee: if the user has intention to connect and contact details are not yet provided, emit "Enter Your Details" UI
  if (!uiAction && (!leadInfo.name || !leadInfo.email)) {
    uiAction = {
      type: 'form_input',
      title: 'Enter Your Details',
      fields: [
        ...(!leadInfo.name ? [{ name: 'name', type: 'text', label: 'Full Name', required: true }] : []),
        ...(!leadInfo.email ? [{ name: 'email', type: 'email', label: 'Email Address', required: true }] : []),
      ],
    };
  }

  // Ensure the mandatory 24-hour response commitment is always present
  const content = typeof response.content === 'string' ? response.content : '';
  if (!content.toLowerCase().includes('24 hours')) {
    response = new AIMessage({
      ...response,
      content: content ? `${content}\n\nVyshnav will personally get in touch within 24 hours. 😊` : 'Vyshnav will personally get in touch within 24 hours. 😊',
    });
  }

  return {
    messages: [response],
    leadInfo,
    uiAction,
  };
}
