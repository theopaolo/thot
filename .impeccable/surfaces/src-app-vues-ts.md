---
version: 1
slug: "src-app-vues-ts"
primary_target: "src/app/vues.ts"
related_targets: ["static/style.css","src/app/routes.ts"]
---

# Surface brief: Thoth student and teacher views

Scope: `src/app/vues.ts` and `static/style.css`. Student surfaces are Read mode, teacher surfaces are Operate mode. Visual authority is the 12/09/2026 handoff in `design/mvp-2026-09-12/`.

Audience: STD2A students revising on a phone, and one teacher certifying sources at a desk. Constraints: Hono, hono/html and HTMX, no build step. Tu for students, vous for teachers. Features without data stay unbuilt: notes, cards, profile, Fiche and Repères tabs.

Deviation from the handoff: on screens under 1180px, the chat source and the chapter reader open in a bottom sheet so the claim stays visible above the passage.

## Direction contract

THESIS: The course is a wall of works and every answer is a caption to a passage. The page refuses the file list and the chatbot thread.

OWN-WORLD: Warm cream #F5F2EC, surface #FDFCFA, ink #1C1815, secondary #6B6460, rules #C9C2B8. Yellow #F0C835 marks the current place and the selection, pale yellow #FAF0C0 marks quoted passages, rose #B8455E marks practice and focus. Atkinson Hyperlegible 400 and 700 only. Outlined buttons with a Phosphor icon and a label, 4px radius, 44px targets. Works sit contained on tinted mats, never cropped. Teacher canvas #F4F4F3 with a side rail.

STORY: The student sees the whole chapter at once, opens a work beside the wall without losing the place, asks a question, and reads each paragraph of the answer next to the passage it rests on.

FIRST VIEWPORT: Chapter page at 1280px. The title and a one-line question field sit on top. Below, the wall of mats grouped by séance fills 7 of 12 columns. A sticky reader fills the other 5, with the selected work large, its cartel, and "Lire le document" as the primary action. The selected mat carries a yellow frame.

FORM: Mur et lecteur, structure 1 of 7 on my ranked list, seed f03edf9e.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
