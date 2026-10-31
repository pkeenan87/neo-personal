"use client";

import { useEveAgent } from "eve/react";

/** Spike: minimal eve chat. Same-origin cookies authenticate the request (agent/channels/eve.ts). */
export function EveChat() {
  const agent = useEveAgent();
  const resuming = agent.status === "resuming";
  return (
    <main style={{ maxWidth: 640, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Neo chat (eve spike)</h1>
      {agent.messages.map((m) => (
        <article key={m.id}>
          <strong>{m.role}</strong>
          {m.parts.map((p, i) => (p.type === "text" ? <p key={p.id ?? i}>{p.text}</p> : null))}
        </article>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("message") as HTMLInputElement;
          const text = input.value.trim();
          if (text && !resuming) {
            void agent.send(text);
            input.value = "";
          }
        }}
      >
        <input name="message" disabled={resuming} aria-label="Message" />
        <button type="submit" disabled={resuming}>Send</button>
      </form>
    </main>
  );
}
