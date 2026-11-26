import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { agentGraph } from '../agent/graph.js';
import { startEmailWorker } from '../workers/emailWorker.js';

console.log('=================================================================');
console.log('🤖 Yoho - AI Portfolio Agent CLI Tester');
console.log('Chat with Yoho (Vyshnav\'s AI agent) directly in your terminal.');
console.log('Type "exit" or "quit" to leave.');
console.log('=================================================================\n');

// Start worker for immediate local testing if Redis is available
try {
  startEmailWorker();
} catch (e: any) {
  console.log('[Notice] Worker skipped in CLI mode:', e.message);
}

const conversationId = uuidv4();
const history: BaseMessage[] = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function promptUser() {
  rl.question('\nYou > ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      promptUser();
      return;
    }

    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      console.log('\nGoodbye!');
      rl.close();
      process.exit(0);
    }

    history.push(new HumanMessage(trimmed));

    try {
      console.log('Agent is thinking (running LangGraph pipeline)...');
      const result = await agentGraph.invoke(
        { messages: history },
        { configurable: { thread_id: conversationId } }
      );

      const lastAiMessage = result.messages[result.messages.length - 1];
      const reply =
        typeof lastAiMessage.content === 'string'
          ? lastAiMessage.content
          : JSON.stringify(lastAiMessage.content);

      history.push(new AIMessage(reply));

      console.log(`\nYoho [Intent: ${result.intent}] >\n${reply}\n`);
    } catch (err: any) {
      console.error('\nError running agent:', err.message);
    }

    promptUser();
  });
}

promptUser();
