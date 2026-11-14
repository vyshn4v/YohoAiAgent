import { StateGraph, END, START } from '@langchain/langgraph';
import { AgentAnnotation, AgentStateType } from './state.js';
import {
  agent1KeywordExtractor,
  pineconeRetrievalNode,
  agent2RelevanceClassifier,
  agent3ProfileSynthesizer,
  enquiryCoordinatorNode,
} from './nodes.js';

/**
 * Builds the Multi-Agent LangGraph workflow.
 *
 * Flow:
 * START -> agent1_keyword_extractor
 *        |-- (intent == 'schedule_enquiry') --> enquiry_coordinator -> END
 *        |-- (default) --> pinecone_retrieval -> agent2_relevance_classifier -> agent3_profile_synthesizer -> END
 */
export function buildAgentGraph() {
  const workflow = new StateGraph(AgentAnnotation)
    // Register nodes
    .addNode('agent1_keyword_extractor', agent1KeywordExtractor)
    .addNode('pinecone_retrieval', pineconeRetrievalNode)
    .addNode('agent2_relevance_classifier', agent2RelevanceClassifier)
    .addNode('agent3_profile_synthesizer', agent3ProfileSynthesizer)
    .addNode('enquiry_coordinator', enquiryCoordinatorNode)

    // Entry point
    .addEdge(START, 'agent1_keyword_extractor')

    // Conditional routing after Agent 1
    .addConditionalEdges(
      'agent1_keyword_extractor',
      (state: AgentStateType) => {
        if (state.intent === 'schedule_enquiry') {
          return 'enquiry_coordinator';
        }
        return 'pinecone_retrieval';
      },
      {
        enquiry_coordinator: 'enquiry_coordinator',
        pinecone_retrieval: 'pinecone_retrieval',
      }
    )

    // Multi-Agent RAG pipeline sequence
    .addEdge('pinecone_retrieval', 'agent2_relevance_classifier')
    .addEdge('agent2_relevance_classifier', 'agent3_profile_synthesizer')
    .addEdge('agent3_profile_synthesizer', END)
    .addEdge('enquiry_coordinator', END);

  return workflow.compile();
}

// Pre-compiled agent graph runnable singleton
export const agentGraph = buildAgentGraph();
