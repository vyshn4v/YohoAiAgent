import { StateGraph, END, START } from '@langchain/langgraph';
import { AgentAnnotation, AgentStateType } from './state.js';
import {
  firstRouterAndUiNode,
  secondExtractorNode,
  thirdGeneratorNode,
} from './nodes.js';

/**
 * 3-Tier Multi-Agent LangGraph Workflow:
 *
 * Flow:
 * START -> first_router_and_ui (AI Call 1: Router, Direct Chat & UI Actions)
 *        |-- (direct / UI / informal / schedule / OTP) --> END (1 single AI call, saves maximum tokens!)
 *        |-- (knowledge query) --> second_extractor (AI Call 2: In-memory sliced JSON fact extraction)
 *                                  -> third_generator (AI Call 3: Response synthesis as Yoho) -> END
 */
export function buildAgentGraph() {
  const workflow = new StateGraph(AgentAnnotation)
    // 3 Core Nodes
    .addNode('first_router_and_ui', firstRouterAndUiNode)
    .addNode('second_extractor', secondExtractorNode)
    .addNode('third_generator', thirdGeneratorNode)

    // Entry point: AI Call 1
    .addEdge(START, 'first_router_and_ui')

    // Conditional Routing after AI Call 1
    .addConditionalEdges(
      'first_router_and_ui',
      (state: AgentStateType) => {
        if (
          state.intent === 'schedule_enquiry' ||
          state.intent === 'general_chat' ||
          state.intent === 'direct'
        ) {
          return END;
        }
        return 'second_extractor';
      },
      {
        [END]: END,
        second_extractor: 'second_extractor',
      }
    )

    // Knowledge pipeline
    .addEdge('second_extractor', 'third_generator')
    .addEdge('third_generator', END);

  return workflow.compile();
}

// Pre-compiled agent graph runnable singleton
export const agentGraph = buildAgentGraph();
