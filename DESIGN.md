---
name: Thot
description: Un atelier d'étude où chaque outil travaille sur des sources certifiées et montre d'où il tient ce qu'il produit.
colors:
  ink: "#1c1815"
  ink-hover: "#2a2520"
  ink-muted: "#6b6460"
  yellow: "#f0c835"
  yellow-surface: "#faf0c0"
  rose: "#b8455e"
  rose-surface: "#f9e8ec"
  bg: "#f5f2ec"
  bg-office: "#f4f4f3"
  surface: "#fdfcfa"
  surface-tinted: "#efebe4"
  line: "#c9c2b8"
  kraft: "#c9ad7f"
  pending: "#985015"
  certified: "#2d7a4a"
  danger: "#c13030"
typography:
  headline:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.15
  title:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.25
  subtitle:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.3
  reading:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.65
  answer:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.75
  body:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    lineHeight: 1.2
  small:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  figures:
    fontFamily: "Atkinson Hyperlegible Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    fontFeature: "tnum"
  code:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "2px"
  md: "4px"
spacing:
  s1: "0.25rem"
  s2: "0.5rem"
  s3: "0.75rem"
  s4: "1rem"
  s5: "1.5rem"
  s6: "2rem"
  s7: "3rem"
  gouttiere: "1rem"
  gouttiere-large: "2rem"
  measure: "32em"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "44px"
  button-active:
    backgroundColor: "{colors.surface-tinted}"
  button-principal:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "44px"
  button-principal-hover:
    backgroundColor: "{colors.ink-hover}"
  button-certifier:
    backgroundColor: "{colors.certified}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "44px"
  button-danger-hover:
    backgroundColor: "{colors.rose-surface}"
  button-lien:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "0"
    height: "24px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
    height: "44px"
  nav-entete:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "44px"
  nav-entete-courant:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
  rail-lien:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "44px"
  rail-lien-hover:
    backgroundColor: "{colors.surface}"
  rail-lien-courant:
    backgroundColor: "{colors.yellow-surface}"
  onglet:
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    padding: "0.5rem 0 0.75rem"
  onglet-courant:
    textColor: "{colors.ink}"
  segment:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 0.75rem"
    height: "36px"
  segment-courant:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
  citation:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.small}"
    rounded: "{rounded.md}"
    padding: "0.05em 0.4em"
  citation-ouverte:
    backgroundColor: "{colors.yellow-surface}"
  question-chat:
    backgroundColor: "{colors.surface-tinted}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.75rem 1rem"
  passe-partout:
    backgroundColor: "{colors.surface-tinted}"
    padding: "0.5rem"
  barre-selection:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.5rem 0.5rem 1rem"
  etiquette-format:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.figures}"
    rounded: "{rounded.sm}"
    padding: "0 0.3rem"
  alerte:
    backgroundColor: "{colors.rose-surface}"
    textColor: "{colors.ink}"
    padding: "0.6rem 0.9rem"
  note:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    padding: "0.6rem 0.9rem"
  panneau:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "1.5rem"
---

# Design System: Thot

Les feuilles de `static/css/` font foi. Ce fichier reprend leurs jetons pour les outils de
conception et dit où chacun sert. Une valeur change d'abord dans sa feuille, puis ici.

`FEUILLES` dans `src/app/vues/page.ts` charge les feuilles dans l'ordre de la cascade. Les jetons
de `:root`, les polices et la typographie sont dans `base.css`. Chaque autre feuille porte les
écrans que nomme son premier commentaire : `navigation.css` l'en-tête de l'élève et le rail de
l'enseignant, `page.css` les composants communs, `documents.css` le texte d'une source,
`lecture.css` l'accueil de l'élève, le chapitre et les feuilles de lecture, `chat.css` le chat et
les conversations, `enseignant.css` les pages de l'enseignant, `impression.css` la feuille
imprimée, `bibliotheque.css` la bibliothèque, `reponses.css` les réponses d'une série,
`activites.css` la pratique et l'éditeur d'activité, `administration.css` les matières, la prise
en main, le dépôt et l'activité des élèves, `dossiers.css` la vue en dossiers et la zone de dépôt,
`eleves.css` les élèves, `relecture.css` la relecture en colonnes, `sommaire.css` le sommaire d'un
cours.

## Overview

**Creative North Star: « L'atelier d'étude »**

Thot est un atelier où l'on apprend. Sur l'établi se trouve la matière : les sources qu'un
enseignant ou un apprenant seul a déposées et certifiées, lues comme les pages d'un wiki. Les
outils restent à portée de main autour de l'établi. Certains reposent sur l'IA, comme la réponse
citée ou la légende d'image proposée. D'autres servent à s'exercer, comme les séries de questions
ou le sommaire qui suit la lecture. Tous travaillent sur la même matière, et chacun montre ce
qu'il a produit et d'où il le tient.

L'ambiance est studieuse et calme : papier crème, encre presque noire, une seule famille de
caractères et des filets de 1px. Les surfaces restent à plat. La matière occupe la plus grande
place à l'écran, tandis que les outils forment une couche plus discrète qui parle partout la même
langue : une icône Phosphor, un verbe, un contrôle cerné, un état écrit en toutes lettres. Un outil
de plus entre dans cette grammaire sans en inventer une autre, si bien que l'atelier peut
s'équiper sans devenir bruyant.

Deux surfaces partagent ce système : l'élève lit, interroge et s'exerce sur le papier crème, tandis
que l'enseignant dépose, certifie et relit sur un fond gris clair, avec un rail de navigation à
gauche. Le mouvement se limite aux transitions entre pages et au carré qui pulse pendant que Thot
travaille, et les deux s'arrêtent sous `prefers-reduced-motion`.

**Key Characteristics:**

- La matière d'abord : le passage, l'image ou la page de cours est plus grand que les contrôles
  qui travaillent dessus.
- Une seule grammaire d'outil : icône Phosphor regular, libellé verbal, contrôle cerné de 1px,
  cible de 44px.
- Le mot avant la couleur : un état se lit dans son libellé, son chiffre ou sa forme.
- À plat : la profondeur vient du ton des papiers et des filets, l'ombre est réservée à ce qui
  flotte.
- Une seule famille : Atkinson Hyperlegible en 400 et 700, sa version Mono pour les codes courts.
- La trace visible : chaque production d'un outil montre sa source et son état.

## Colors

La palette se compose de papier et d'encre, si bien que la couleur repère l'endroit où quelqu'un
agit. Elle double alors un mot, un chiffre ou une forme, qui portent le sens à sa place.

### Primary

- **Encre** (`ink`) : le texte, le fond de l'action principale d'une zone et la marque de
  l'élément courant (lien d'en-tête rempli, segment rempli, tuile cadrée, onglet souligné). Au
  survol, l'action principale passe à l'**encre levée** (`ink-hover`).

### Secondary

- **Jaune surligneur** (`yellow`) : la trace de Thot. Il souligne un passage surligné, borde le
  haut de la feuille basse qui montre une source et pulse dans la ligne d'étape pendant que Thot
  cherche.
- **Surlignage pâle** (`yellow-surface`) : le fond d'un passage surligné, de la sélection de texte,
  d'une citation ouverte et de la page courante du rail enseignant.

### Tertiary

- **Rose correcteur** (`rose`) : l'anneau de focus clavier, et la main de l'enseignant qui note. On
  le trouve sur le bouton de note enfoncé et sur la case d'une réponse rédigée qui attend sa note.
- **Rose pâle** (`rose-surface`) : le fond d'une alerte, d'une case en attente de note et du survol
  d'un bouton qui efface.

### Neutral

- **Papier crème** (`bg`) : le fond des pages élève.
- **Papier de bureau** (`bg-office`) : le fond de la surface enseignant.
- **Feuille** (`surface`) : les contrôles, les tableaux, les panneaux, le lecteur collé et la
  feuille basse. Elle se pose sur le papier sans ombre.
- **Passe-partout** (`surface-tinted`) : le fond autour d'une image, la question posée dans le
  chat, l'état enfoncé d'un bouton et le survol d'une ligne de liste.
- **Graphite** (`ink-muted`) : le texte secondaire, l'aide, les métadonnées, l'onglet inactif.
- **Filet** (`line`) : le bord des contrôles et les filets entre lignes et sections.
- **Kraft** (`kraft`) : les dossiers de la vue Dossiers.

### États

Chaque couleur d'état accompagne le mot de son `.statut`.

- **Ocre d'attente** (`pending`) : « à relire », « en cours », une réponse juste au deuxième
  essai.
- **Vert tampon** (`certified`) : « certifiée », le bouton Certifier, la note de confirmation, la
  bonne réponse d'une distribution, une case juste.
- **Rouge** (`danger`) : « rejetée », « échec », une erreur de champ, une action qui efface, une
  case fausse.

### Named Rules

**La règle du mot d'abord.** Un état se lit dans son libellé, son chiffre ou sa forme, et la
couleur le répète. La grille des réponses écrit 1, 0,5, 0 ou ? dans chaque case, et chaque statut
porte son mot. Test : en niveaux de gris, chaque état reste distinct.

**La règle de l'acteur.** Chaque teinte appartient à quelqu'un qui agit : le jaune à Thot qui cite,
le rose à l'enseignant qui annote, le vert à l'enseignant qui certifie, le kraft au rangement. Un
outil nouveau reprend la teinte de son acteur au lieu d'en recevoir une. Les étiquettes de format
de la vue Dossiers font exception : elles empruntent le rose pour un PDF et l'ocre pour un
PowerPoint, et leur texte porte l'extension.

**La règle du contraste sur crème.** Un texte atteint 4,5:1 sur le papier crème et sur la feuille.
Sur le papier crème, le graphite atteint 5,2:1, l'ocre 5,4:1, le rouge 5,0:1, le vert 4,7:1 et le
rose 4,6:1. Sur le passe-partout, le vert et le rose tombent à 4,4:1, donc un texte de statut ne se
pose pas sur le passe-partout.

Le bord des champs, la page courante du rail et la citation ouverte ne suivent pas encore ces
règles : `tasks/ensuite/ui-111.md` décrit les écarts.

## Typography

**Display Font:** Atkinson Hyperlegible en 400 et 700, avec `system-ui` et une sans-serif en repli
**Body Font:** Atkinson Hyperlegible, la même famille que les titres
**Label/Mono Font:** Atkinson Hyperlegible Mono en 400 et 600 pour les codes courts, la chasse fixe
du système (`ui-monospace`) pour les blocs de code

**Character:** le Braille Institute a dessiné Atkinson Hyperlegible pour que les lettres faciles à
confondre (l, I, 1, O, 0) se distinguent. La police donne à Thot une voix nette et un peu ronde, qui
reste lisible en petit sur un téléphone, et sa version Mono garde cette voix pour les compteurs.

### Hierarchy

- **Headline** (`headline`) : le titre de la page. Il passe à 2rem à partir de 900px et ses lignes
  s'équilibrent (`text-wrap: balance`).
- **Title** (`title`) : les titres de section.
- **Subtitle** (`subtitle`) : les sous-sections, une séance, la proposition de légende, les
  premiers pas.
- **Reading** (`reading`) : les paragraphes d'un document. La mesure de 32em donne environ 72
  signes par ligne en français, alors que 65ch d'Atkinson en donnerait 95.
- **Answer** (`answer`) : le texte d'une réponse de Thot. Son interligne, plus large que celui de la
  lecture, laisse la place aux marques de citation glissées dans la ligne.
- **Body** (`body`) : le reste de l'interface.
- **Label** (`label`) : les boutons, les liens de navigation, les onglets.
- **Small** (`small`) : l'aide, les métadonnées, les statuts, les en-têtes de tableau.
- **Figures** (`figures`) : les compteurs, les formats de fichier, les identifiants d'élève.
- **Code** (`code`) : les blocs de code du lecteur, des réponses et des séries. Le code en ligne
  d'un cours prend la même chasse fixe, un peu plus petite que le texte, sur le fond passe-partout.

### Named Rules

**La règle des deux graisses.** 400 sert à lire, 700 à titrer et à agir. Les titres gardent leur
casse et leur approche normales.

**La règle de la chasse fixe.** La Mono sert aux codes courts que l'œil compare d'une ligne à
l'autre : un format, un compteur, un identifiant. Une durée ou une date reste en Atkinson, avec des
chiffres tabulaires quand elle s'aligne en colonne.

## Layout

L'échelle `s1` à `s7` (de 4 à 48px) règle tous les écarts. La gouttière vaut `gouttiere` sur
téléphone et `gouttiere-large` à partir de 900px. Une section s'ouvre par un filet en haut, sans
cadre autour.

Côté élève, la page est centrée et limitée à 76rem. Un document tient dans 52rem et ses paragraphes
dans la mesure. À partir de 75rem, le sommaire du texte se colle à droite. À partir de 85rem, les
ressources du thème prennent une troisième colonne à gauche.

Le chat garde une colonne de 48rem au plus. À partir de 1180px, la source citée s'ouvre dans une
colonne à droite (40 % de la largeur, 26rem au moins). À partir de 1400px, la liste des
conversations prend 16rem à gauche. Sous 1180px, la source et le lecteur s'ouvrent dans une feuille
basse, si bien que la phrase qui cite reste visible au-dessus de son passage. La page chapitre
donne 7 colonnes sur 12 au mur de tuiles et 5 au lecteur collé à partir de 1180px.

Côté enseignant, un rail collé de 15rem tient la navigation et le contenu va jusqu'à 90rem. Le rail
se replie en icônes sur 4,5rem, avec le libellé en bulle au survol et au focus. Sous 900px, il
devient une barre en haut avec les liens sur trois colonnes, puis deux sous 640px.

Les cibles font 44px, et 36px pour les contrôles secondaires des tableaux et des segments. Une
marque de citation reste petite à l'œil, mais sa zone de clic atteint 44px. Les pages élève tiennent
dès 320px de large. Un tableau ou un bloc de code défile dans son cadre au lieu d'élargir la page.

## Elevation & Depth

Thot reste à plat : la profondeur vient de trois tons de papier (le fond, la feuille, le passe-partout)
et des filets. Une ombre apparaît seulement sous une couche qui passe au-dessus de la page.

### Shadow Vocabulary

- **Menu** (`box-shadow: 0 2px 8px rgb(28 24 21 / 0.08)`) : le menu du compte. La feuille basse
  porte la même ombre tournée vers le haut (`0 -2px 8px`).
- **Panneau** (`box-shadow: 0 8px 24px rgb(28 24 21 / 0.12)`) : les dialogues et la grille de choix
  du cours. Derrière un dialogue, la page s'assombrit à `rgb(28 24 21 / 0.2)`.

Les ombres intérieures ne donnent pas de profondeur, elles tracent une marque. On en compte quatre :
un cadre de 3px à l'encre sur la tuile ou la carte choisie, un soulignement de 3px sous l'onglet
courant, un liseré de 3px à gauche du chapitre en cours et un trait jaune de 2px sous un passage
surligné.

### Named Rules

**La règle du flottant.** Une ombre signale qu'une couche passe au-dessus de la page. Un élément
qui reste dans le flux n'en porte pas, même au survol.

## Shapes

Les contrôles, les panneaux, les dialogues et la question du chat ont des coins arrondis à 4px
(`rounded.md`). Un élément logé dans un autre contrôle descend à 2px (`rounded.sm`) : un segment,
une case de la grille des cours, une étiquette de format. La matière et ses cadres gardent l'angle
droit : le passe-partout, l'image, le tableau, le lecteur collé, la feuille basse.

Les bords font 1px, en filet au repos et à l'encre au survol. Une zone de dépôt est tracée en
tirets de 2px. Les chevrons des sections dépliables sont deux bordures tournées à 45°.

Les icônes viennent de Phosphor 2.1.1, graisse regular (`src/app/icones.ts`). Elles mesurent 1,25em,
prennent la couleur du texte et restent décoratives, parce que le libellé voisin porte le sens. Un
passe-partout est carré et montre l'image entière.

## Components

### Buttons

Les boutons sont cernés et discrets. Un bouton est une feuille avec un filet de 1px, un libellé en
gras et, au besoin, une icône à gauche du libellé. Au survol, le filet passe à l'encre. Enfoncé, le
fond passe au passe-partout. Au focus, un anneau rose de 3px s'écarte de 2px du bord, comme sur
tout élément atteint au clavier.

- L'action principale est remplie d'encre, et une zone n'en compte qu'une.
- Certifier est le seul bouton rempli de vert, parce que certifier appose le tampon de l'enseignant.
- Une action qui efface pour de bon a le texte et le filet rouges, et un fond rose pâle au survol.
- Le bouton-lien, souligné et sans cadre, porte les actions secondaires d'une ligne, par exemple
  « Retirer » un cours.
- « Copier » se pose au-dessus d'un bloc de code, à droite, et ne cache aucune ligne du code.
- Un bouton désactivé descend à 45 % d'opacité. Pendant une requête HTMX, il descend à 60 % avec un
  curseur d'attente.

### Segments et onglets

Les onglets choisissent le corpus, les segments filtrent ou changent l'affichage. Deux niveaux
reçoivent donc deux formes.

- Un onglet est un libellé graphite posé sur un filet. L'onglet courant passe à l'encre avec un
  soulignement de 3px.
- Les segments forment un groupe dans un cadre de feuille. Le segment courant est rempli d'encre et
  son compteur passe en filet. Un segment sans résultat reste en graphite.

### Cards / Containers

Thot range ses listes avec des filets plutôt qu'avec des cartes. Une ligne de liste ou de tableau
se sépare de la suivante par un filet, et un tableau se pose sur la feuille avec des en-têtes
graphite.

Les encadrés restent rares : les identifiants à imprimer, « Le saviez-vous », la figure d'un
schéma, la réponse hors du cours ou en panne. Chacun est une feuille cernée d'un filet, sans ombre,
et seule la figure a des coins arrondis.

Le passe-partout porte une image : un carré au fond passe-partout, avec l'image entière au centre.
Choisi, il reçoit un cadre intérieur de 3px à l'encre. Une source rejetée passe en gris à 40 %.

### Inputs / Fields

Un champ est une feuille cernée d'un filet, haute de 44px. Son libellé en gras se place au-dessus,
son aide en graphite dessous. Au focus, le filet passe à l'encre et l'anneau rose s'ajoute. Une
erreur s'écrit en rouge sous le champ. Les cases à cocher et les boutons radio sont natifs, à 20px,
teintés à l'encre. Dans une ligne de liste, un libellé autour de la case lui donne une cible de
36px. Dans la bande défilante des vignettes de légende, l'anneau de focus passe à l'intérieur de la
vignette, que le cadre rognerait sinon.

Le composeur du chat reste collé en bas de l'écran, et sa zone de texte grandit avec son contenu
jusqu'à 8rem. Une zone de dépôt passe à l'encre sur fond passe-partout quand un fichier survole la
page.

### Navigation

L'en-tête élève place la marque à gauche, puis la recherche et des liens cernés de 44px. Le lien de
la page courante est rempli d'encre. Sous 640px, les liens perdent leur cadre et leur icône et
prennent un libellé court, et la recherche passe sur sa propre ligne.

Le rail enseignant aligne des liens de 44px avec icône et libellé. Un long nom d'instance passe à
la ligne et le bouton qui replie le rail reste dans sa colonne. Un lien prend le fond feuille au
survol et le fond surlignage pâle sur la page courante. Le pied du rail tient la vue élève et la
déconnexion.

Le fil d'Ariane de la vue Dossiers sépare ses éléments par une barre oblique graphite et met
l'élément courant en gras. Le sommaire du lecteur aligne des liens graphite contre un filet
vertical. La page d'une série reprend ce sommaire comme index de ses questions, collé à droite à
partir de 75rem : chaque lien donne le numéro et le type de la question, puis « À revoir » ou « À
vérifier » quand elle demande d'agir. Dans le sommaire d'un cours, un chapitre lu montre son numéro dans une pastille d'encre,
et le chapitre ouvert porte un liseré de 3px. Les liens précédent et suivant ferment le texte sous
un filet.

### Citation

La citation relie une phrase de Thot au passage qui la prouve. C'est un petit bouton cerné glissé
dans la ligne, avec l'icône guillemets et le numéro en chiffres tabulaires, et sa zone de clic
atteint 44px. Ouverte, elle prend le fond surlignage pâle et un filet jaune, et le passage s'ouvre
dans la colonne source ou dans la feuille basse. La feuille rend les blocs qui portent le passage
avec le gabarit du lecteur : une ligne de tableau citée reste dans son tableau, un code en ligne
reste du code.

### Feuille basse

Sous 1180px, la source citée et le lecteur s'ouvrent dans une feuille fixée en bas de l'écran,
haute de 65dvh au plus et bordée en haut d'un trait jaune de 4px. La page réserve la même hauteur
en bas pour que rien ne passe dessous. Dans la feuille, les titres rapetissent pour que le passage
ou l'image reste l'élément le plus grand.

### Ligne d'étape

Pendant que Thot travaille, la réponse affiche l'étape en cours en graphite, précédée d'un carré
jaune qui pulse, avec le bouton « Arrêter » sur la même ligne. Le carré s'immobilise sous
`prefers-reduced-motion`.

### Barre de sélection

Dès qu'une case est cochée dans la bibliothèque, une barre d'encre se colle en bas de l'écran. Elle
affiche le nombre d'éléments choisis et les actions groupées. Ses boutons sont cernés de graphite
sur l'encre, l'action principale passe en feuille et Certifier reste vert.

### Vue Liste

La liste de la bibliothèque range les ressources en plis sur la feuille, un pli par cours, ou
par thème quand un cours est choisi ou que toutes les ressources tiennent dans un seul cours.
Chaque pli porte son nom et son nombre de ressources, puis seulement ce qui reste à faire, en mots
(« 2 à relire », « 24 légendes non relues ») : un pli où tout est certifié n'affiche aucun état.
Ouvert, il montre ses ressources sur deux colonnes, numérotées dans l'ordre de lecture comme dans
le sommaire élève. Une ressource n'affiche son statut que s'il diffère de « certifiée ». Un pli
s'ouvre de lui-même pour une ressource en cours, en échec, à relire ou rejetée. Des légendes non
relues se comptent sans ouvrir le pli, puisqu'elles ont leur page. Un filtre ouvre tous les plis.

### Vue Dossiers

La bibliothèque se lit aussi comme un explorateur de fichiers. Les cours et les thèmes sont des
dossiers kraft, les documents un contour graphite sur papier blanc avec une étiquette de format en
Mono, les activités une icône à l'encre. Un élément coché prend le fond passe-partout et son nom
passe en blanc sur encre.

### Menu d'actions

Sous une question d'activité, « Modifier » reste visible et « Autres actions », icône trois points,
ouvre les autres actions dans un popover ancré sous son bouton, ou au centre sans ancrage CSS. Le
menu est une feuille cernée avec l'ombre menu. Ses boutons gardent icône et libellé et une cible de
44px, sans cadre, avec le passe-partout au survol et un filet entre les groupes. L'action qui
efface reste rouge, avec le rose pâle au survol.

### Avancement d'une série

En haut d'une série, une ligne collée compte les questions faites, « 4 faites sur 23 », et mène à
la première qui reste. Elle porte le fond de la page et un filet dessous. Chaque question dit sa
place, « Question 6 sur 23 », le compte en graphite.

### Schémas

Un schéma Mermaid se dessine en figure sur la feuille, sa légende numérotée dessous, son code replié
sous la légende. Un bloc animé de carnet se dessine dans son état final, et ses notes passent en
liste numérotée entre le dessin et la légende.

### Étapes

Les étapes du dépôt et de « Pour commencer » se suivent en liste. Une étape faite remplace son
numéro par la coche verte et le dit au lecteur d'écran.

### Panneaux, alertes et notes

Un dialogue est une feuille cernée aux coins de 4px, large de 36rem au plus, avec l'ombre panneau.
La grille de choix du cours s'ancre sous son bouton quand le navigateur gère l'ancrage CSS, et
s'ouvre au centre sinon. Les onglets Ressources et Activités la partagent. Une page introuvable ou
une erreur du serveur garde la mise en page, dit ce qui s'est passé et ramène à l'accueil.

Une alerte a un fond rose pâle et un filet rouge à gauche. Une note de confirmation a un fond
feuille et un filet vert à gauche. Côté élève, une réponse hors du cours ou une panne reste calme :
un encadré feuille sans couleur de statut, dont le texte nomme la cause.

## Do's and Don'ts

### Do:

- **Do** donner la plus grande place à la matière : le passage, l'image ou la page de cours dépasse
  en taille les contrôles qui travaillent dessus.
- **Do** construire un outil nouveau avec les composants existants : bouton cerné avec icône et
  verbe, segments, statut, feuille basse, panneau. Un composant nouveau vient seulement quand aucun
  ne convient.
- **Do** montrer la provenance de ce qu'un outil produit : la citation vers son passage, la ligne
  de provenance, le statut « à relire » tant que l'enseignant n'a pas certifié.
- **Do** écrire chaque état en mot ou en chiffre, puis le doubler de couleur.
- **Do** marquer l'élément courant à l'encre et par une forme : fond plein, soulignement ou liseré
  de 3px, cadre intérieur.
- **Do** garder une seule action remplie d'encre par zone.
- **Do** séparer les lignes et les sections par un filet de 1px.
- **Do** mesurer le contraste sur le papier crème et sur la feuille : 4,5:1 pour un texte, 3:1 pour
  le bord d'un champ.
- **Do** couper le mouvement sous `prefers-reduced-motion`.

### Don't:

- **Don't** porter un état par la seule teinte.
- **Don't** donner à un outil sa propre couleur, sa propre police ou un autre jeu d'icônes.
- **Don't** poser d'ombre sur un élément du flux, arrondir au-delà de 4px ou encadrer une ligne de
  liste dans une carte.
- **Don't** recadrer une image de contenu : elle tient entière sur son passe-partout.
- **Don't** ajouter d'interlettrage, de titre en capitales, de police à empattements ou de seconde
  famille.
- **Don't** reprendre l'allure du chatbot généraliste, avec ses bulles de part et d'autre et son
  avertissement « l'IA peut se tromper ». Une réponse est un texte à la mesure de lecture, et
  chaque phrase porte sa citation.
- **Don't** reprendre l'allure de l'ENT gris et institutionnel (Moodle), contre-modèle de
  `PRODUCT.md`.
- **Don't** colorer un hors-cours ou une panne côté élève : le texte en dit la cause.
