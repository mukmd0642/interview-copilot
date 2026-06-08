# Competitive Landscape & Strategy — June 2026

*Produced from four parallel research agents (web-verified). Competitor facts are vendor-stated unless flagged; "undetectable" claims, latency, language counts, and pass-rates are marketing and were treated skeptically. This space moves monthly — re-verify before acting on any single number.*

## TL;DR — our roadmap already hit the whitespace

The market splits into two camps: **stealth coding-solvers** (Interview Coder, LeetCode Wizard, UltraCode, CodeAce, Interview Solver) and **live verbal-answer copilots** (Final Round AI, Sensei, LockedIn AI, Verve, Parakeet, Cluely). Independently, every research agent concluded the same set of features are **rare or missing across the entire market** — and we've built or just shipped most of them:

| Differentiator | Market status | Us |
|---|---|---|
| **Agentic multi-capture** (AI tells candidate to scroll/open files & re-capture) | **MISSING — strongest whitespace.** Interview Coder is closest but *passive* (user re-screenshots); nobody's AI drives the loop. | ✅ `request_view` loop |
| **Interviewer-voice → coding solver** | RARE & shallow (Interview Solver, InterviewCodeAssist) | ✅ interviewer speech feeds the agent + auto Q&A banner |
| **Code-review mode** (review existing code, not just debug your own) | RARE (only LockedIn, IDE-locked) | ✅ just shipped |
| **Guided step-by-step apply + verification** | **MISSING — nobody offers it.** Everyone dumps a wall of code. | ✅ just shipped (apply → screenshot-verify → next) |
| **Answer-length control** | UNCOMMON (Verve, Interviews.chat); absent on coding side | ✅ just shipped (Brief/Standard/Detailed) |
| Bilingual / Spanish live answers | COMMON — table stakes | ✅ en/es/pt-BR |
| Secondary-device companion | Exists *as stealth*; **honest framing is unclaimed** | ❌ not yet (STATUS TODO) |

We've effectively assembled the category's scattered "rare" features into one product. That's the headline.

## The field (verified highlights)

**Stealth coding-solvers**
- **Interview Coder** (interviewcoder.co) — the brand-name original; **$60/mo** (some sources cite $299/mo or $799 lifetime ⚠️ inconsistent). Model undisclosed. **Documented real catches** on CoderPad & HackerRank; pop-ups seen during screen-share. Slow (>20s on a Medium).
- **LeetCode Wizard** (leetcodewizard.io) — openly calls itself "cheating app"; algorithm ranking by complexity; **phone web-view mirroring** for proctored exams; **€49/mo**.
- **UltraCode** (ultracode.ai) — names its models (o3 / GPT-5.x / Claude), "ThoughtFlow" explanations, verbal + follow-ups; **~$799–899 lifetime**.
- **CodeAce** (codeace.ai) — only one to fully disclose stack (**Gemini 3 + Claude 4.5**), 12 languages; **$199/mo or $599 lifetime**.
- **Interview Solver** (interviewsolver.com) — cheapest serious one (**$39/mo**), screenshot + dual-audio + companion mode; *honestly* states stealth ceiling "Zoom ≤ 6.16".

**Verbal copilots**
- **Final Round AI** — category leader, broadest features, **$81–148/mo**; serious **billing-complaint/"scam" review baggage**; weak length control (a top complaint); reviewers report lag.
- **LockedIn AI** — explicit **English+Spanish bilingual mode**, in-IDE code review; advertises <1s but **independently tested at 4–5s**; browser extension gets users caught.
- **Verve AI** — **55+ languages**, live answer-length hotkeys (Cmd+↑/↓), stealth on browser+desktop, **~$38–60/mo**.
- **Parakeet** — user-selectable **GPT-5 / GPT-4.1 / Claude 4**, 50+ languages; but macOS leaks a process named `pmodule` and detection vendors specifically target it.
- **Sensei**, **Interviews.chat** — browser-based, <1s claims; Interviews.chat has the best documented **format controls** (STAR/bullets) and multi-model side-by-side.
- **Cluely** — the viral one (Roy Lee). **Pivoted away from "cheat on everything" to an honest meeting-notetaker**; stealth is now a **$149.99/mo add-on**. Founder **publicly admitted faking revenue** ($7M→$5.2M); suffered an **83,000-user data breach** (transcripts + screenshots leaked).

## Four strategic truths from the research

1. **Latency is the category's credibility gap.** Everyone advertises <1s / 116ms / 300ms; independent tests show **4–10s** (LockedIn 4–5s, Cluely 5–10s). The 5-second "latency stare" is the real detection risk. **Honest, genuinely-low latency is winnable** — which is exactly why the gpt-5-mini-for-answers + warm-up direction matters.

2. **macOS stealth is largely broken; Windows still works.** Windows `WDA_EXCLUDEFROMCAPTURE` reliably hides the overlay from Zoom/Teams/Meet in 2025–2026. On **macOS 15.4+ (Sequoia), `NSWindowSharingNone` is defeated by ScreenCaptureKit** — overlays can render straight into the shared stream (worst case for a cheat tool), and there's **no public API to prevent capture**. Most competitors hide this. Our STATUS already flags it — being **honest about Mac + rock-solid on Windows + companion fallback** is a trust differentiator.

3. **Detection is winning the arms race, and the market is fleeing stealth.** Proctors flag ~35% of assessments (HackerRank, 2025, ~2× prior year); detection vendors (Fabric, Sherlock) claim 85%+ via gaze/timing/keystroke/second-screen. The only structurally low-detection method anyone endorses is a **separate physical device** — and even that loses to gaze analysis and a human noticing. The category leader (Cluely) **abandoned the "cheating" frame**. Strategic read: pure undetectability is a depreciating asset.

4. **Trust/privacy is an open wedge.** Cluely's breach + revenue lie, Final Round's billing complaints — the incumbents have shaky trust on exactly the sensitive data (resumes, audio, screen). We already hold the API key main-side and never ship it to the renderer; a **privacy/clean-billing/honest story** is credible positioning.

## Idea suggestions (prioritized)

**Lean into the moat (build-on-strength):**
1. **Make the agentic loop the headline of the product.** It's the one thing no competitor has. Market it as "the copilot that *reads your screen like a senior engineer* — it'll ask you to scroll or open the test file, then solve." This is our defensible differentiator; everything else is catch-up.
2. **Deepen interviewer-voice fusion in code mode.** Today the agent gets interviewer context + answers questions. Next: let a spoken constraint ("now handle duplicates", "what's the space complexity") **update the on-screen solution live**. Nobody does this well.
3. **Latency push (already in motion).** gpt-5-mini default for verbal answers + a warm-up call on Start + the now-tighter answer lengths. Then *honestly benchmark* first-word latency and put the real number on the box — the whole category lies here.

**Hedge the stealth cliff (strategic):**
4. **Ship the secondary-device companion — but frame it honestly.** It's the only durable-stealth path AND the bridge to the "consented assistant" world the market is moving toward. "Here's my AI assistant, on my phone, transparently" is **conceptually unclaimed** — everyone else frames second-device as *more* stealth.
5. **Be honest about macOS.** Transparent "Windows is fully hidden; on recent macOS use the companion view" beats a false cross-platform "undetectable" claim that fails in a real Sequoia interview.
6. **Privacy as a feature.** Lean on key-held-main-side; consider BYOK / local-first transcript handling as a wedge against the breached incumbent.

**Bundle the table-stakes (positioning):**
7. **One coherent mid-priced app** ($30–40/mo equivalent) that combines coding + verbal + bilingual + length-control + companion — a clean hole between cheap-narrow (Interview Solver $39) and premium-verbal (LockedIn/Final Round $90–148). We already have most pieces.
8. **Model transparency + choice.** Disclosing the stack (and maybe letting users pick gpt-5 vs gpt-5-mini per mode) is itself a trust/feature lever the secretive incumbents cede.

## Sources (representative)
interviewcoder.co · leetcodewizard.io · ultracode.ai · codeace.ai · interviewsolver.com · finalroundai.com · lockedinai.com · vervecopilot.com · parakeet-ai.com · senseicopilot.com · interviews.chat · cluely.com (+/pricing) · a16z.com/announcement/investing-in-cluely · techcrunch.com (Cluely revenue admission, Mar 2026) · learn.microsoft.com (SetWindowDisplayAffinity) · developer.apple.com/forums/thread/792152 (ScreenCaptureKit) · adamsvoboda.net/how-interview-cheating-tools-hide-from-zoom · fabrichq.ai · hackerrank.com (2025 proctoring playbook) · github.com (Natively, Glass/Pickle, Cheating Daddy)

*Caveats: Interview Coder pricing is inconsistent across sources; LockedIn/Verve/Parakeet gate dollar amounts (third-party numbers); latency and language counts are the least trustworthy data points and should be benchmarked, not trusted.*
