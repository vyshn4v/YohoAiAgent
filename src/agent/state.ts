import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';
import { RetrievedDocument } from '../services/pineconeService.js';

export interface LeadInfo {
  name?: string;
  email?: string;
  phone?: string;
  reason?: string;
}

export const AgentAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  intent: Annotation<'profile_query' | 'schedule_enquiry' | 'general_chat' | 'direct' | 'knowledge'>({
    reducer: (_, next) => next,
    default: () => 'profile_query',
  }),
  categories: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  slicedData: Annotation<Record<string, any>>({
    reducer: (_, next) => next,
    default: () => ({}),
  }),
  relevantFacts: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  finalMessage: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),
  extractedKeywords: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),
  retrievedDocs: Annotation<RetrievedDocument[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  classifiedDocs: Annotation<RetrievedDocument[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  leadInfo: Annotation<LeadInfo>({
    reducer: (current, next) => ({ ...current, ...next }),
    default: () => ({}),
  }),
  uiAction: Annotation<Record<string, any> | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
});

export type AgentStateType = typeof AgentAnnotation.State;
