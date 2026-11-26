import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { configureLangSmithEnv } from '../src/config/index.js';
import {
  decisionRouterNode,
  getGoogleGenAiClient,
  pgVectorRetrieverNode,
  scheduleEnquiryNode,
  bigModelKnowledgeNode,
} from '../src/agent/nodes.js';
import * as pgVectorService from '../src/services/pgVectorService.js';

describe('LangSmith Tracing Configuration & Traceable Integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes LANGSMITH_* variables into LANGCHAIN_* defaults for tracing and health checks', () => {
    const mockEnv: Record<string, string | undefined> = {
      LANGSMITH_API_KEY: 'lsv2_test_key_value',
      LANGSMITH_TRACING: 'true',
      LANGSMITH_ENDPOINT: 'https://api.smith.langchain.com',
    };

    const result = configureLangSmithEnv(mockEnv);

    expect(result.apiKey).toBe('lsv2_test_key_value');
    expect(result.project).toBe('ai-portfolio-agent');
    expect(mockEnv.LANGCHAIN_API_KEY).toBe('lsv2_test_key_value');
    expect(mockEnv.LANGCHAIN_TRACING_V2).toBe('true');
    expect(mockEnv.LANGCHAIN_PROJECT).toBe('ai-portfolio-agent');
    expect(mockEnv.LANGCHAIN_ENDPOINT).toBe('https://api.smith.langchain.com');
    expect(mockEnv.LANGSMITH_PROJECT).toBe('ai-portfolio-agent');
  });

  it('also populates LANGSMITH_* when only LANGCHAIN_API_KEY is provided', () => {
    const mockEnv: Record<string, string | undefined> = {
      LANGCHAIN_API_KEY: 'ls_legacy_key',
      LANGCHAIN_PROJECT: 'custom-project',
    };

    const result = configureLangSmithEnv(mockEnv);

    expect(result.apiKey).toBe('ls_legacy_key');
    expect(result.project).toBe('custom-project');
    expect(mockEnv.LANGSMITH_API_KEY).toBe('ls_legacy_key');
    expect(mockEnv.LANGSMITH_TRACING).toBe('true');
    expect(mockEnv.LANGSMITH_PROJECT).toBe('custom-project');
  });

  it('executes traceable-wrapped decision, retrieval, and generator nodes cleanly with RunnableConfig', async () => {
    const ai = getGoogleGenAiClient();
    vi.spyOn(ai.decisions, 'create').mockResolvedValueOnce({
      answers: { intent: { type: 'choice', choice: 'knowledge_query' } },
    } as any);

    const runConfig = { configurable: { thread_id: 'trace-test-conv' } };
    const decision = await decisionRouterNode(
      { messages: [new HumanMessage('Tell me about Vyshnav projects')] } as any,
      runConfig
    );
    expect(decision.intent).toBe('profile_query');

    const searchSpy = vi.spyOn(pgVectorService, 'searchResumeChunks').mockResolvedValueOnce([
      {
        id: 'chunk-ls-1',
        chunkIndex: 0,
        title: 'Projects',
        content: 'YohoAiAgent built with LangGraph',
        metadata: {},
        similarity: 0.91,
      },
    ]);

    const retrieval = await pgVectorRetrieverNode(
      {
        messages: [new HumanMessage('Tell me about Vyshnav projects')],
        extractedKeywords: 'Vyshnav projects',
      } as any,
      runConfig
    );
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(retrieval.retrievedDocs).toHaveLength(1);

    const llmSpy = vi
      .spyOn(ChatOpenAI.prototype, 'invoke')
      .mockResolvedValueOnce(new AIMessage('Vyshnav built YohoAiAgent.') as any);

    const generated = await bigModelKnowledgeNode(
      {
        messages: [new HumanMessage('Tell me about Vyshnav projects')],
        retrievedDocs: retrieval.retrievedDocs,
      } as any,
      runConfig
    );

    expect(generated.finalMessage).toBe('Vyshnav built YohoAiAgent.');
    expect(llmSpy).toHaveBeenCalledWith(expect.any(Array), runConfig);
  });

  it('forwards RunnableConfig into scheduleEnquiryNode structured extractor', async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      name: null,
      email: null,
      phone: null,
      reason: 'Consultation',
      otp: null,
      action: 'request_info',
    });

    vi.spyOn(ChatOpenAI.prototype, 'withStructuredOutput').mockReturnValueOnce({
      invoke: invokeMock,
    } as any);

    const runConfig = { configurable: { thread_id: 'trace-sched-conv' } };
    await scheduleEnquiryNode(
      { messages: [new HumanMessage('Book a call')] } as any,
      runConfig
    );

    expect(invokeMock).toHaveBeenCalledWith(expect.any(String), runConfig);
  });
});
