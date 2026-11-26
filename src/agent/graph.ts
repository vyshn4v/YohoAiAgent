import { StateGraph, END, START } from '@langchain/langgraph';
import { AgentAnnotation, AgentStateType } from './state.js';
import {
  decisionRouterNode,
  greetingSmallModelNode,
  scheduleEnquiryNode,
  pgVectorRetrieverNode,
  bigModelKnowledgeNode,
} from './nodes.js';

/**
 * 4-Tier Multi-Agent LangGraph Workflow:
 *
 * Flow:
 * START -> decision_router (Decision AI: gemini-decision-1)
 *        |-- (greeting) -> greeting_small_model (Small Model: gemini-flash-lite) -> END
 *        |-- (schedule_enquiry) -> schedule_enquiry (Small Model Contact Extractor + OTP/Booking) -> END
 *        |-- (out_of_scope) -> END (Zero-AI deterministic scope boundary reply)
 *        |-- (knowledge_query) -> pgvector_retriever (Embeds with gemini-embedding-2 & queries PostgreSQL)
 *                                  -> knowledge_big_model (Big Model: gemini-3.5-flash-lite) -> END
 */
export function buildAgentGraph() {
  const workflow = new StateGraph(AgentAnnotation)
    // Core Pipeline Nodes
    .addNode('decision_router', decisionRouterNode)
    .addNode('greeting_small_model', greetingSmallModelNode)
    .addNode('schedule_enquiry', scheduleEnquiryNode)
    .addNode('pgvector_retriever', pgVectorRetrieverNode)
    .addNode('knowledge_big_model', bigModelKnowledgeNode)

    // Entry point: AI Call 1 (Decision AI)
    .addEdge(START, 'decision_router')

    // Conditional Routing after Decision AI
    .addConditionalEdges(
      'decision_router',
      (state: AgentStateType) => {
        if (state.intent === 'direct' || state.intent === 'out_of_scope') {
          return END;
        }
        if (state.intent === 'greeting') {
          return 'greeting_small_model';
        }
        if (state.intent === 'schedule_enquiry') {
          return 'schedule_enquiry';
        }
        return 'pgvector_retriever';
      },
      {
        greeting_small_model: 'greeting_small_model',
        schedule_enquiry: 'schedule_enquiry',
        pgvector_retriever: 'pgvector_retriever',
        [END]: END,
      }
    )

    // Routing from greeting small model to END
    .addEdge('greeting_small_model', END)

    // Routing from schedule enquiry to END
    .addEdge('schedule_enquiry', END)

    // Routing for knowledge pipeline: pgvector retriever -> big model -> END
    .addEdge('pgvector_retriever', 'knowledge_big_model')
    .addEdge('knowledge_big_model', END);

  return workflow.compile();
}

// Pre-compiled agent graph runnable singleton
export const agentGraph = buildAgentGraph();
