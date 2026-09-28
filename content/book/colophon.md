---
title: "Colophon"
kind: "Back matter"
numbered: false
---

## How this book was made {#how-made}

This book was generated with AI, using three tools, from materials curated by Thomas Lockney for this purpose:

- **Writing.** The text, the diagrams, the self-quiz, and the lab notebooks were written by Anthropic's Claude, working in Claude Code.
- **Research.** Research on the core topics (the Workers platform, Durable Objects, the actor model, and durable execution) was done with Gemini Notebook, driven through the [gemini-notebook-mcp-cli](https://github.com/jacob-bd/gemini-notebook-mcp-cli) tool.
- **Review.** Reviews of the material were run with Hermes Agent, using the GLM-5.3 and DeepSeek V4.1 Flash models.

Thomas chose the subject and the sources, set the scope and the structure, and directed each revision, including acting on those reviews, which checked the text against celld's documentation and led to corrections. The sources were celld's documentation and release notes (v0.4.0 through v0.6.0), Cloudflare's documentation and engineering posts, and a curated set of articles on actors and durable execution. The Bibliography lists all of them.

The labs were not simulated. Each notebook was executed against a real `celld dev` node (celld v0.6.0, Deno 2.9.6) on a homelab JupyterLab on 2026·09·26, and the outputs are shown exactly as that run produced them. Where a run showed less than the prose once claimed, the prose was changed to match the output, never the reverse.

## Accuracy {#accuracy}

The claims in this book were checked against the sources listed in the Bibliography, and many against a running node. Even so, AI-generated text can contain errors, and celld is a young project that changes quickly. Verify anything you depend on against the release you install and against celld's own documentation. This book is not affiliated with or endorsed by Deno or Cloudflare.

## History {#history}

| Date | Event |
|----|----|
| 2026·08·30 | The field guide (now Part II) first written, for celld v0.4.0 |
| 2026·08·31 | The step-by-step guide (now Part III) first written, for v0.4.0 |
| 2026·09·15 to 09·26 | Revised for v0.4.1, v0.5.0, v0.5.1, and v0.6.0; the three labs written and executed |
| 2026·09·27 | Rewritten as one description of v0.6.0; the primer (now Part I) and the review sheet added |
| 2026·09·28 | Assembled as this book |

## Production {#production}

The chapters are generated from the same markdown sources and notebooks as the companion Reading Room series, by a small Deno build. Pages are rendered with the "bench sheet" layout: section numbers, code languages, and callout kinds in the left margin, set in Source Serif 4, IBM Plex Sans Condensed, and JetBrains Mono. Code is highlighted with highlight.js and markdown is parsed with marked.
