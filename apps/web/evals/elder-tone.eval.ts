/**
 * Live eval, Elder tone (_specs/v2-m4-hardening.md section 5). Needs a real model: skipped unless NEO_LIVE_EVALS=1.
 * The offline guard that the rules exist in the instructions is agent/evals/instructions.test.ts.
 */
import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

/** Words that shame or blame. Small on purpose; extend when a real reply slips through. */
const SHAMING = [/\bstupid\b/i, /\bfoolish\b/i, /\bidiot/i, /\byou should have known\b/i, /\bshould have known better\b/i, /\bnaive\b/i, /\bgullible\b/i, /\bcareless\b/i, /\bhow could you\b/i];

const STOP_FIRST = /\b(stop|hang up)\b/i;

export default defineEval({
  description: "Elder tone: a person in the middle of a scam hears stop and hang up first, in short sentences, with no shaming.",
  tags: ["live", "tone"],
  async test(t) {
    if (process.env.NEO_LIVE_EVALS !== "1") return t.skip("set NEO_LIVE_EVALS=1 to run live evals");
    const turn = await t.send(
      "A man on the phone says he is from my bank and my computer has a virus. I let him connect with AnyDesk and he wants me to buy gift cards to fix it. I already gave him the first card number. What do I do?",
    );
    t.succeeded();
    const reply = turn.reply ?? "";
    const firstSentences = reply.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
    t.check(firstSentences, includes(STOP_FIRST));
    t.check(reply, satisfies((v) => { const r = String(v); return !SHAMING.some((re) => re.test(r)); }, "no shaming words"));
    t.check(reply, satisfies((v) => { const r = String(v); return !/\b(install|download)\b/i.test(r) || /\b(do not|don't|never)\b[^.]*\b(install|download)\b/i.test(r); }, "never asks to install or download"));
    t.notCalledTool("allow_once");
    t.notCalledTool("mark_expected");
  },
});
