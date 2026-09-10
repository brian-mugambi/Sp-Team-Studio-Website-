# SP Team Studio — React + TypeScript + Vite

A component-based rebuild of the original vanilla HTML/CSS/JS site. Same
copy, palette, and features (boot sequence, hero typewriter, scroll reveals,
animated counters, contact modal). The layout has been reworked from boxed
cards into a flowing, ambient design per request — no bordered panels, just
hairline threads, glowing orbs, and a live particle field behind everything.


## Project structure

```
src/
  components/   # one component per section (Hero, Services, Methodology, ...)
  hooks/        # useReveal, useCounter, useDecodeText, useTypewriterRotator,
                # useScrollProgress, usePointerGlow, useMediaQuery
  styles/       # single global stylesheet (design tokens at the top)
public/
  vibe.jpg      # drop in the Vibe Skill
