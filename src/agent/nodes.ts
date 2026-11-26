export {
  getGoogleGenAiClient,
  getGreetingSmallModel,
  getKnowledgeBigModel,
  getLlmModel,
  getOpenRouterModel,
} from './llm/modelFactory.js';

export { decisionRouterNode } from './nodes/decisionRouterNode.js';
export { scheduleEnquiryNode } from './nodes/scheduleEnquiryNode.js';
export { greetingSmallModelNode } from './nodes/greetingNode.js';
export { pgVectorRetrieverNode } from './nodes/pgVectorRetrieverNode.js';
export { bigModelKnowledgeNode } from './nodes/knowledgeNode.js';

import { decisionRouterNode } from './nodes/decisionRouterNode.js';
import { pgVectorRetrieverNode } from './nodes/pgVectorRetrieverNode.js';
import { bigModelKnowledgeNode } from './nodes/knowledgeNode.js';

// Backward compatibility node aliases
export const firstRouterAndUiNode = decisionRouterNode;
export const secondExtractorNode = pgVectorRetrieverNode;
export const thirdGeneratorNode = bigModelKnowledgeNode;
