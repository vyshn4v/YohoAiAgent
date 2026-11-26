import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';

export interface RetrievedDocument {
  id: string;
  score: number;
  text: string;
  metadata?: Record<string, any>;
}

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
  intent: Annotation<
    | 'greeting'
    | 'profile_query'
    | 'schedule_enquiry'
    | 'direct'
    | 'out_of_scope'
    | string
  >({
    reducer: (_, next) => next,
    default: () => 'profile_query',
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
  leadInfo: Annotation<LeadInfo>({
    reducer: (current, next) => ({ ...current, ...next }),
    default: () => ({}),
  }),
  isVerified: Annotation<boolean>({
    reducer: (_, next) => next,
    default: () => false,
  }),
  uiAction: Annotation<Record<string, any> | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
});

export type AgentStateType = typeof AgentAnnotation.State;
