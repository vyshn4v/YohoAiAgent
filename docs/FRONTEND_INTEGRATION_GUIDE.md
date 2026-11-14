# Frontend Integration Guide: SSE Streaming & Dynamic In-Chat Inputs

This document explains how frontend applications (React, Next.js, Vue, Svelte, or Vanilla JS) connect to the **Yoho AI Backend** to handle real-time token streaming and dynamic in-chat input widgets.

---

## 1. High-Level Concept

```
User Message
    │
    ▼
POST /api/chat/stream
    │
    ├──► 1. event: status     (Pipeline stage: searching knowledge base, etc.)
    ├──► 2. event: token      (Token-by-token stream for typing effect)
    ├──► 3. event: ui_action   (Instructs frontend to render inline widget)
    └──► 4. event: done       (Turn finalized with full reply & lead status)
    │
    ▼
Frontend renders interactive <OtpInput /> inside the chat bubble
    │
    ▼
User enters 6 digits ──► Auto-submits to /api/chat/stream ──► Meeting Confirmed
```

---

## 2. API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/chat/stream` | Primary streaming endpoint (SSE). Accepts JSON body `{ message, conversationId }`. |
| `GET` | `/api/chat/stream` | Browser `EventSource`-compatible stream (`?message=...&conversationId=...`). |
| `POST` | `/api/chat` | Non-streaming JSON endpoint (also supports SSE if `Accept: text/event-stream` header is passed). |
| `GET` | `/api/docs` | Interactive Swagger UI documentation with live schema explorer. |

---

## 3. Server-Sent Events (SSE) Protocol

When calling `POST /api/chat/stream`, the connection remains open (`Content-Type: text/event-stream`) and pushes the following event types:

### Event 1: Pipeline Progress (`event: status`)
Informs the frontend of the agent's current stage in the RAG pipeline.

```text
event: status
data: {"node":"agent1_keyword_extractor","status":"understanding_query"}

event: status
data: {"node":"pinecone_retrieval","status":"searching_knowledge_base"}

event: status
data: {"node":"agent3_profile_synthesizer","status":"generating_answer"}
```

**Frontend Action**: Display a subtle status indicator (e.g. *"Yoho is searching knowledge base..."*).

---

### Event 2: Token Chunks (`event: token`)
Delivers words/characters in real time as OpenRouter/LLM produces them.

```text
event: token
data: {"token":"Hello! ","conversationId":"550e8400-e29b-41d4-a716-446655440000"}

event: token
data: {"token":"I'm Yoho...","conversationId":"550e8400-e29b-41d4-a716-446655440000"}
```

**Frontend Action**: Append `data.token` to the current message bubble to produce a smooth typewriter animation.

---

### Event 3: Dynamic In-Chat Input (`event: ui_action`)
Emitted when the AI agent needs structured user input (such as an OTP verification code).

```text
event: ui_action
data: {
  "type": "otp_input",
  "title": "Enter 6-Digit Verification Code",
  "email": "vyshnav@gmail.com",
  "length": 6,
  "description": "Please enter the 6-digit code sent to vyshnav@gmail.com",
  "placeholder": "123456"
}
```

**Frontend Action**: Attach this `uiAction` object to the active message so the chat bubble mounts the dedicated widget component.

---

### Event 4: Turn Completion (`event: done`)
Signals that generation has finished.

```text
event: done
data: {
  "conversationId": "550e8400-e29b-41d4-a716-446655440000",
  "reply": "I've sent a 6-digit verification code to your email...",
  "intent": "schedule_enquiry",
  "leadInfo": {
    "name": "Alex",
    "email": "vyshnav@gmail.com"
  },
  "uiAction": {
    "type": "otp_input",
    "email": "vyshnav@gmail.com",
    "length": 6
  }
}
```

**Frontend Action**: Stop typing indicators and persist message to conversation history.

---

## 4. How Dynamic In-Chat Inputs Work (Generative UI)

### The Problem
Traditional chat bots only accept text from the bottom input bar. When the bot asks for a verification code, the user is forced to manually type *"Here is my code 123456"* into the text bar, which is tedious and prone to typos.

### The Solution: Inline Widgets
With this architecture, the chat bubble itself renders an interactive UI widget based on `uiAction`:

1. **Detection**:
   When `message.uiAction?.type === 'otp_input'`, the frontend mounts an inline **6-box OTP component** directly inside the bot's message bubble.
2. **User Experience**:
   - The user sees 6 individual digit boxes `[ ][ ][ ][ ][ ][ ]`.
   - The user types the 6 numbers or pastes the code from their email.
3. **Auto-Submission**:
   - As soon as all 6 digits are entered, the widget automatically calls the send message function with the 6-digit string (e.g. `123456`).
   - The user never needs to touch the bottom input bar.

---

## 5. Multi-Turn Session Memory

To ensure details (name, email, phone, reason) are never lost between turns:

1. **Generate Session ID**:
   Generate a unique UUID on client load:
   ```javascript
   const conversationId = crypto.randomUUID();
   ```
2. **Send With Every Request**:
   Include `conversationId` in all subsequent requests:
   ```json
   {
     "message": "My name is Alex and my email is alex@example.com",
     "conversationId": "550e8400-e29b-41d4-a716-446655440000"
   }
   ```
3. **Automatic Context Preservation**:
   The backend session remembers the conversation history and previously supplied details (`leadInfo`). When the user submits their OTP, the backend matches it to the existing session without asking them to re-enter their name or reason.

---

## 6. CORS & Cross-Domain Support

The backend is configured with permissive CORS headers for Server-Sent Events:
- `Access-Control-Allow-Origin`: Dynamically matches the requesting frontend domain or subdomain.
- `Access-Control-Allow-Credentials`: `true`.
- `X-Accel-Buffering: no`: Disables reverse-proxy buffering (Nginx / Cloudflare) to ensure immediate token delivery.

---

## 7. Fixing: "Bot Icon Showing on Initialization Screen"

### Why This Happens in the Frontend

If your frontend shows a floating bot icon or an empty assistant bubble during the initial loading/welcome screen, it is typically caused by one of three frontend state issues:

1. **State initialized with an empty assistant message**:
   ```javascript
   // ❌ INCORRECT:
   const [messages, setMessages] = useState([
     { role: 'assistant', content: '' } // Renders bot icon with no text on load!
   ]);

   // ✅ CORRECT:
   const [messages, setMessages] = useState([]); // Start with clean empty array
   ```

2. **Appending an empty assistant message before any tokens arrive**:
   ```javascript
   // ❌ INCORRECT:
   const sendMessage = (text) => {
     setMessages(prev => [
       ...prev,
       { role: 'user', content: text },
       { role: 'assistant', content: '' } // ❌ Shows bot icon immediately during pipeline status!
     ]);
   };

   // ✅ CORRECT:
   // Only add the assistant message when the FIRST token or uiAction actually arrives:
   let assistantMessageCreated = false;

   // When parsing SSE chunks:
   if (event === 'token' || event === 'ui_action') {
     if (!assistantMessageCreated) {
       assistantMessageCreated = true;
       setMessages(prev => [...prev, { role: 'assistant', content: '', uiAction: null }]);
     }
     // Append token or attach uiAction...
   }
   ```

3. **Rendering the bot avatar when content is empty**:
   ```jsx
   // ❌ INCORRECT:
   {messages.map((msg) => (
     <div key={msg.id} className="message-row">
       {msg.role === 'assistant' && <BotAvatar />}
       <div>{msg.content}</div>
     </div>
   ))}

   // ✅ CORRECT:
   // Only render if there is actual content, an active uiAction, or actively streaming:
   {messages.map((msg, index) => {
     const hasContent = msg.content && msg.content.trim().length > 0;
     const hasWidget = Boolean(msg.uiAction);
     const isCurrentlyStreaming = isStreaming && index === messages.length - 1;

     // Do NOT render ghost bubbles
     if (!hasContent && !hasWidget && !isCurrentlyStreaming) return null;

     return (
       <div key={msg.id} className={`message-row ${msg.role}`}>
         {msg.role === 'assistant' && <BotAvatar />}
         <div className="bubble">
           {msg.content}
           {msg.uiAction?.type === 'otp_input' && <OtpInput {...msg.uiAction} />}
           {msg.uiAction?.type === 'form_input' && <ContactForm {...msg.uiAction} />}
         </div>
       </div>
     );
   })}
   ```

4. **Empty State / Welcome Screen Guard**:
   When no messages have been sent yet (`messages.length === 0`), render the clean welcome hero screen instead of the message list:
   ```jsx
   {messages.length === 0 ? (
     <WelcomeHero onSuggestionClick={(prompt) => sendMessage(prompt)} />
   ) : (
     <MessageList messages={messages} isStreaming={isStreaming} />
   )}
   ```

5. **Chat Input Must Remain Active While Receiving Messages**:
   Do **not** disable the text `<input>` or `<textarea>` while the AI is responding. Only the Send button should be disabled:
   ```jsx
   // ❌ INCORRECT: Freezes the input and frustrates the user while AI is streaming
   <input disabled={isStreaming} />

   // ✅ CORRECT: Input remains fully interactive; only prevent submission
   <input
     value={input}
     onChange={(e) => setInput(e.target.value)}
     onKeyDown={(e) => {
       if (e.key === 'Enter' && !isStreaming && input.trim()) sendMessage();
     }}
     placeholder={isStreaming ? "AI is responding... (you can still type)" : "Type your message..."}
   />
   <button disabled={isStreaming || !input.trim()}>Send</button>
   ```

---

## 8. Complete React / Next.js Implementation Example

```tsx
import React, { useState, useRef } from 'react';

interface UiAction {
  type: 'form_input' | 'otp_input';
  title?: string;
  email?: string;
  fields?: Array<{ name: string; type: string; label: string; required: boolean }>;
  error?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  uiAction?: UiAction | null;
}

export function PortfolioChat() {
  const [messages, setMessages] = useState<Message[]>([]); // ✅ Starts empty
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [pipelineStatus, setPipelineStatus] = useState<string | null>(null);
  const conversationIdRef = useRef<string>(crypto.randomUUID());

  const sendMessage = async (textToSend?: string) => {
    const text = (textToSend || input).trim();
    if (!text || isStreaming) return;

    // 1. Add user message
    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsStreaming(true);
    setPipelineStatus('Understanding your query...');

    try {
      const response = await fetch('http://localhost:3000/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversationId: conversationIdRef.current,
        }),
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let botMsgCreated = false;
      const botMsgId = crypto.randomUUID();

      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const block of lines) {
          const eventMatch = block.match(/^event:\s*(\w+)/m);
          const dataMatch = block.match(/^data:\s*(.*)/m);
          if (!eventMatch || !dataMatch) continue;

          const event = eventMatch[1];
          const data = JSON.parse(dataMatch[1]);

          if (event === 'status') {
            setPipelineStatus(data.status.replace(/_/g, ' '));
          }

          // Only create the bot bubble when the first real token or widget arrives!
          if (event === 'token' || event === 'ui_action') {
            if (!botMsgCreated) {
              botMsgCreated = true;
              setMessages((prev) => [
                ...prev,
                { id: botMsgId, role: 'assistant', content: '', uiAction: null },
              ]);
            }
          }

          if (event === 'token') {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === botMsgId ? { ...msg, content: msg.content + data.token } : msg
              )
            );
          }

          if (event === 'ui_action') {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === botMsgId ? { ...msg, uiAction: data } : msg
              )
            );
          }

          if (event === 'done') {
            setPipelineStatus(null);
          }
        }
      }
    } catch (err) {
      console.error('Chat error:', err);
    } finally {
      setIsStreaming(false);
      setPipelineStatus(null);
    }
  };

  return (
    <div className="chat-container">
      {/* Initialization / Welcome Screen: NO BOT ICON WHEN EMPTY */}
      {messages.length === 0 ? (
        <div className="welcome-screen">
          <h2>👋 Hi, I'm Yoho!</h2>
          <p>Ask me about Vyshnav's skills, projects, or schedule a meeting.</p>
          <div className="suggestions">
            <button onClick={() => sendMessage('Tell me about your technical skills')}>
              💻 Technical Skills
            </button>
            <button onClick={() => sendMessage('I want to connect with Vyshnav')}>
              🤝 Connect / Schedule Call
            </button>
          </div>
        </div>
      ) : (
        <div className="message-list">
          {messages.map((msg) => (
            <div key={msg.id} className={`message-bubble ${msg.role}`}>
              {/* Bot icon ONLY appears alongside a real assistant message */}
              {msg.role === 'assistant' && <div className="bot-avatar">🤖</div>}
              <div className="content">
                <p>{msg.content}</p>

                {/* Inline 6-Digit OTP Widget */}
                {msg.uiAction?.type === 'otp_input' && (
                  <div className="otp-widget">
                    <h4>{msg.uiAction.title}</h4>
                    <p>{msg.uiAction.description}</p>
                    <input
                      type="text"
                      maxLength={6}
                      placeholder="123456"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.currentTarget.value.length === 6) {
                          sendMessage(e.currentTarget.value);
                        }
                      }}
                    />
                  </div>
                )}

                {/* Inline Contact Details Form */}
                {msg.uiAction?.type === 'form_input' && (
                  <div className="details-form">
                    <h4>{msg.uiAction.title}</h4>
                    {msg.uiAction.fields?.map((f) => (
                      <input key={f.name} type={f.type} placeholder={f.label} required={f.required} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Pipeline status indicator (e.g. searching knowledge base) */}
          {pipelineStatus && (
            <div className="status-indicator">
              <span>⚡ {pipelineStatus}...</span>
            </div>
          )}
        </div>
      )}

      {/* Input Bar: Input is ALWAYS active so the user can type their next query; only Send button is disabled */}
      <div className="input-bar">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isStreaming && input.trim()) {
              sendMessage();
            }
          }}
          placeholder={isStreaming ? "Yoho is typing... (you can continue typing)" : "Type your message..."}
          /* ✅ Input is never disabled during streaming */
        />
        <button onClick={() => sendMessage()} disabled={isStreaming || !input.trim()}>
          {isStreaming ? 'Streaming...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
```
