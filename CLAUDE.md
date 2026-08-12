# oxum-dev-dashboard — instructions projet

Terminal embarqué avec, au-dessus, une bande de statut sur les projets front (serveur de dev, git,
checks GitHub). Toutes les actions des lignes se lancent dans un onglet de ce terminal.

## Repo privé, mais prudence quand même

Ce dépôt manipule des noms de branches `PROJ-XXXX`, des titres de PR et des chemins de repos
internes. Il est **privé** : ne pas le passer en public, et ne jamais y committer de capture
montrant du contenu client. Les tokens de couleur restent nommés `--brand-*`.

## Invariants à ne pas casser

- **Un booléen ne suffit pas pour l'état serveur.** Les scripts `start` lancent `npm run lint` avant
  de servir : `lint` et `lint-error` sont des états réels. Les réduire ferait afficher « ne tourne
  pas » pendant une phase saine.
- **`design-system` n'est pas un serveur** (`ng build --watch`, aucun port). Son état ne peut venir que
  de sa sortie, donc le dashboard doit posséder le processus. Ne pas lui inventer de port.
- **L'identité d'une ligne est le chemin du repo**, jamais le port. Un worktree du même projet tourne
  sur un autre port et doit rester distinct.
- **`taskkill /T /F` pour arrêter**, pas `pty.kill()` : ce dernier ne touche que le `cmd.exe`
  d'enveloppe et laisse `ng serve` tenir le port.
- **Le dashboard ne décrit que les processus qu'il possède.** L'état `external` et la sonde de port qui
  le nourrissait (`port-probe.ts`, `Get-NetTCPConnection` + `CommandLine` → chemin du repo) ont été
  retirés : depuis que tout se lance dans le terminal embarqué, c'était un état sur lequel on ne pouvait
  pas agir, pour une situation qui n'arrivait plus. Conséquence assumée : si un serveur tourne encore
  hors du dashboard, la ligne affiche `arrêté` et l'action échoue visiblement sur « address in use »
  dans son onglet. Si ça se remet à arriver, c'est la sonde qu'il faut ressusciter (elle savait deux
  choses non évidentes : sonder `localhost` et jamais `127.0.0.1`, les serveurs Angular n'écoutant
  qu'en IPv6 ; et l'enveloppe de tableau de PowerShell 5.1).
- **Confirmation avant de quitter** quand des processus possédés tournent : ils meurent avec l'app.
- **Le renderer reste sandboxé** : pas de `fs`, pas de `child_process`, CSP verrouillée, DOM construit
  avec `textContent` (branches, erreurs et titres de PR viennent de l'extérieur).

## Architecture : le terminal est le centre

- **Le terminal occupe tout l'espace restant** (`flex: 1`), la bande projets a une hauteur stockée.
  Ne pas revenir à un panneau terminal escamotable : c'est la surface principale.
- **Toute action d'une ligne se termine dans un onglet du terminal.** Aucun terminal externe, aucune
  fenêtre tierce.
- **La bande projets doit montrer les projets sans défilement** dans sa hauteur par défaut. Si les
  lignes grandissent, ajuster `projectsHeight` en conséquence.
- La section « sessions Claude Code » a été retirée volontairement : lancer les commandes depuis les
  projets donne déjà l'état. Ne pas la réintroduire sans demande explicite.
- **Les réglages sont une fenêtre, pas une modale.** En overlay, un `click` se déclenche sur
  l'ancêtre commun de son `mousedown` et de son `mouseup` : sélectionner du texte dans un champ et
  relâcher hors du panneau fermait la boîte. Et une modale masque le tableau qu'elle configure. La
  fenêtre est **indépendante** (pas de `parent`), sinon elle resterait collée au-dessus du dashboard
  et suivrait sa minimisation.
- **Deux pages de renderer, un seul preload.** `index.html` et `settings.html` sont deux entrées
  déclarées dans `electron.vite.config.ts` ; oublier la seconde la fait charger depuis le disque en
  dev, sans hot reload. Le chargement passe par `loadRendererPage`, jamais par un `loadURL` recopié.
- **Ce que la fenêtre de réglages écrit revient par diffusion.** Le main envoie `SettingsChanged` à
  toutes les fenêtres et le dashboard se reconstruit depuis cet événement. Corollaire : le formulaire
  reçoit l'écho de sa propre sauvegarde, d'où la signature de configuration qui distingue l'écho d'un
  vrai changement externe. Sans elle, la confirmation « enregistré » était effacée aussitôt.
- **L'invite « modifications non enregistrées » vit dans le main.** Seul le handler `close` de la
  fenêtre peut encore annuler la fermeture, donc le renderer lui signale son état via
  `SettingsDirty` ; la question est posée en `showMessageBoxSync`, une réponse attendue en `await`
  arriverait trop tard.

## Terminal

- **Une session terminal n'appartient pas à un projet.** `TerminalManager` est indexé par
  `TerminalId`. Revenir à une clé par projet rendrait impossible d'avoir un shell ouvert pendant
  qu'un serveur tourne, ce qui est le cas d'usage normal.
- **Le bouton `Terminal` et le clic sur la ligne ne sont pas le même geste**, et c'est la distinction
  qui compte : la ligne revient toujours au shell unique du dépôt, le bouton ouvre **un nouvel onglet**
  dans son dossier à chaque clic. Le bouton passe donc par `openShell` et non `openProjectShell`, ce
  qui laisse ces onglets sans `projectId` : invisibles pour la recherche de réutilisation de la ligne,
  et jamais fermés par `reconcile`. Le bouton avait été retiré une fois comme redondant avec le clic,
  ce qu'il n'était pas : cette lecture supprimait le seul moyen d'ouvrir un deuxième shell sur un même
  dépôt.
- **Trois contrôles ouvrent un terminal dans un dépôt, et ils sont volontairement identiques** : le
  bouton `Terminal` du tableau, l'icône de la liste des PR et celle de la colonne de dépôts du Git. Même
  geste, donc même glyphe : `TERMINAL_ICON` vit dans `renderer/ui/icons.ts`, qui n'existe que pour les
  icônes à plus d'un consommateur (les flèches de sync restent dans `git-panel.ts`, le chevron dans
  `terminal-pane.ts`). Deux copies d'un tracé finissent en deux glyphes légèrement différents pour la
  même action, et une icône vaut précisément par sa reconnaissance avant lecture. Les deux icônes
  passent par `createIconButton`, dont le paramètre `label` est **obligatoire** : une icône seule ne dit
  rien à un lecteur d'écran, et rendre le nom facultatif serait la garantie que la prochaine icône n'en
  aura pas. La liste des PR disait `Terminal` en mots jusque-là ; c'était la chose la plus large de la
  ligne après le titre, pour énoncer ce que toute l'app implique déjà.
- **`.icon-button--row` porte les contrôles d'icône d'une ligne de liste** (taille réduite, discrets
  jusqu'au survol de leur ligne). Une seule règle pour les deux listes : c'étaient deux blocs identiques
  qui ne différaient que par une opacité que personne n'avait choisie, ce qui est exactement la façon
  dont deux contrôles faisant la même chose finissent par ne plus se ressembler.
- **Cliquer une ligne ouvre le shell du dépôt, et le réutilise.** Le geste est trop facile à
  déclencher pour empiler un onglet par clic. Un shell de dépôt porte donc un `projectId` **et** pas
  d'`actionId` : tout code qui parcourt ces deux champs doit accepter ce couple. La règle de
  fermeture vit dans `isUnreachable`, pure et testée, précisément parce que ce cas s'y trompe.
- **Un clic sur un contrôle ne doit pas atteindre la ligne** (`closest('button, input, …')`). Sans ça,
  un clic sur une action la lance *et* ouvre un shell, et le double-clic de renommage ouvre un
  terminal qui vole le focus au champ qui vient d'apparaître.
- **Un panneau est un GROUPE d'onglets, pas une session.** `TerminalGroup = { tabs, active }`. Avant,
  un panneau *était* une session et la barre d'onglets était unique au-dessus de toute la surface :
  splitter divisait donc la **vue** pendant que la barre continuait de lister toutes les sessions de
  l'app, ce qui donnait deux fenêtres sur une seule barre. Un split donne maintenant un terminal
  complet, onglets compris, et déplacer un onglet d'un panneau à l'autre n'est qu'un déplacement entre
  groupes. Deux invariants portent tout : **un groupe n'est jamais vide** et **une session est dans
  exactement un groupe**. Ils sont tenus à un seul endroit, `normalizeGroups`.
- **`shared/terminal-groups.ts` est partagé exprès.** Le renderer calcule une disposition, le main
  valide la même forme avec les mêmes fonctions. Deux implémentations de « cette disposition est-elle
  saine » finiraient par ne plus être d'accord, et la conséquence (un panneau blanc, une session sans
  onglet) est invisible tant qu'on ne la subit pas.
- **Une session orpheline est adoptée, jamais jetée.** `normalizeGroups` rattache au dernier groupe
  toute session vivante qu'aucun groupe ne cite. C'est la panne dangereuse : sans onglet nulle part,
  un processus tourne sans rien pour l'afficher ni l'arrêter. C'est aussi ce qui rend visible un
  onglet fraîchement lancé avant que le renderer ait dit où il le voulait.
- **Ne jamais détacher un terminal xterm du DOM.** `open()` sort tôt quand le terminal a déjà un
  élément : le détacher le laisse vivant mais invisible pour toujours. Un conteneur permanent par
  session, on bascule `hidden`. C'est aussi pourquoi la surface est une **grille** et pourquoi bandes,
  vues et séparateurs sont tous enfants directs de la surface, placés sur des **lignes de grille
  explicites** (`stripLine`, `viewLine`, `splitterLine`, pures et testées). Une bande qui envelopperait
  sa vue obligerait à déplacer un xterm quand son onglet change de panneau, donc à le tuer.
- **La disposition des panneaux est à une seule direction** (`columns` ou `rows`), pas un arbre
  imbriqué. Choix assumé face à Windows Terminal : la position d'un panneau se déduit de son index, ce
  qui rend l'arithmétique pure et testable. Ne pas introduire de mélange des directions sans passer à
  un vrai arbre.
- **La disposition vit dans le main, et elle EST l'ordre des onglets.** Il n'y a plus deux autorités :
  le canal `terminal:reorder` et l'ordre d'insertion de la `Map` ont disparu, un onglet est là où son
  groupe le dit. Le renderer calcule la structure entière et l'envoie, le main la valide et la
  rediffuse ; `syncLayout` la recale quand une session naît ou meurt.
- **Cliquer un onglet le montre dans SON panneau**, sans rien remplacer ni réduire : avec une barre par
  panneau, ce geste ne peut plus vouloir dire autre chose. C'était l'inverse avant (l'onglet prenait la
  place du panneau focalisé), et cette règle-là n'a plus de raison d'être.
- **Fermer un panneau ne tue pas ses terminaux** : ses onglets passent au panneau voisin. La vue et la
  vie d'un terminal sont deux choses distinctes ; un clic dans un menu contextuel ne doit pas pouvoir
  arrêter un serveur de dev.
- **`moveTab` prend le voisin, pas un index.** `before` est l'onglet devant lequel atterrir, lu dans la
  liste **privée de l'onglet déplacé**. Un index calculé sur une liste qui contient encore l'onglet
  tiré vise une case trop tôt dès qu'on déplace vers la droite : c'est le bug que l'ancien `reorderIds`
  avait déjà, désigner le voisin le rend impossible.
- **Un dépôt sur la bande elle-même, hors des onglets, ajoute au bout de ce panneau.** C'est ce qui
  fait d'une bande presque vide une cible valide, et le geste pour « mets ce terminal dans ce
  panneau-là » quand on vise le panneau et pas une position.
- **Chaque panneau visible a besoin de son propre `fit`.** Avec un split, chaque pty a sa géométrie :
  n'en ajuster qu'un laisserait les autres couper leur sortie à la mauvaise largeur.
- **Les raccourcis sont posés sur `document` en phase de capture**, sinon l'xterm focalisé les avale.
  `Ctrl+Alt` plus une lettre, jamais un chiffre (clavier suisse français), et un garde sur
  `event.repeat` : sans lui, garder le raccourci enfoncé ouvre un shell par répétition.
- **Copier/coller : renvoyer `false` du `attachCustomKeyEventHandler` ne suffit pas.** Ça n'empêche
  que le traitement xterm de la touche, pas l'action par défaut du navigateur : sans
  `event.preventDefault()`, le keydown `Ctrl+V` déclenche encore l'événement `paste` natif sur le
  textarea caché de xterm, que xterm écoute aussi — le texte était collé deux fois. La décision
  (copie seulement avec sélection, `Ctrl+C` reste SIGINT sinon, garde AltGr) vit dans
  `decideTerminalKey`, pure et testée ; le menu contextuel du panneau passe par les mêmes
  `copySelection`/`pasteInto` que le raccourci.
- **Le rendu passe par l'addon WebGL**, pas le renderer DOM par défaut. Le DOM sous le compositing
  GPU de Chromium laissait des glyphes figés à l'écran pendant le scroll (vu en vrai) ; le canvas
  WebGL est repeint entier, rien ne peut y rester. Trois règles, chacune payée : l'addon se charge
  depuis `fitVisible`, **jamais dans `ensure()`** — une vue peut naître pour un onglet en
  arrière-plan (`write` accumule l'historique des sessions cachées) et un canvas WebGL initialisé en
  `display: none` naît avec une géométrie fausse qui ressort en glyphes figés hors de la grille à
  l'affichage. Chaque `fit` est suivi d'un `term.refresh` complet — un resize ne repeint que la
  nouvelle grille, pas ce que l'ancienne a laissé autour. Et `onContextLoss` dispose l'addon
  (Chromium plafonne les contextes WebGL vivants par page et évince le plus ancien) : xterm retombe
  seul sur le renderer DOM, l'état `failed` évitant de recharger un contexte qui serait ré-évincé.
- **xterm doit savoir qu'il parle à ConPTY** (`windowsPty`, alimenté par `terminalCompat` dans le
  bootstrap). Sans ça il suppose un pty Unix et **refait lui-même le reflow** de son tampon à chaque
  resize, alors que ConPTY reflow et réimprime de son côté depuis le tampon de console qu'il possède :
  deux propriétaires réécrivent les mêmes lignes à partir d'origines différentes, et le perdant laisse
  des caractères en place. C'est ça, les « lettres fantômes » vues avec un TUI plein écran. Le numéro
  de build n'est pas décoratif, xterm change de comportement à 21376 : `parseWindowsBuild` rejette un
  build `0` plutôt que de deviner, un mauvais numéro étant pire que pas de numéro.
- **`rescaleOverlappingGlyphs: true`.** Un caractère de largeur ambiguë (`⎿`, `●`, les traits de
  cadre, le spinner d'une session Claude Code) fait une cellule de large pour la police mais peint
  plus large. Sous WebGL seules les cellules marquées sales sont repeintes, donc les pixels débordés
  dans une cellule que personne n'a touchée cette frame restent à l'écran. Option WebGL uniquement,
  ce qui est exactement notre cas.
- **Pas de `convertEol`.** Elle fait qu'un `\n` seul renvoie aussi le chariot : c'est un correctif
  pour une sortie branchée directement, pas pour une sortie de pty où les fins de ligne sont déjà
  celles que le programme a voulues. Laissée active, un saut de ligne seul émis pour descendre **en
  gardant la colonne** (ce que fait un TUI qui redessine une frame sur place) ramenait le curseur en
  colonne 0 : le redessin repartait au mauvais endroit et ne recouvrait jamais la queue de la frame
  précédente.
- **Le pty n'est prévenu que quand la géométrie a vraiment changé.** `fitVisible` tourne à chaque
  rendu : changement d'onglet, focus d'un panneau, ouverture des notes, et une fois par `pointermove`
  pendant le glissement d'un séparateur. Un resize de la même taille n'est pas gratuit sous Windows
  (ConPTY réimprime l'écran qu'il détient) et un TUI plein écran répond à chacun en redessinant toute
  sa frame. `View.sent` mémorise la dernière taille annoncée ; la comparaison ne coûte rien et
  supprime tous les resize redondants.
- **Effacer, c'est les deux bouts ou aucun.** `pty.clear()` est un no-op partout sauf sur ConPTY, et
  sur ConPTY c'est tout l'intérêt : il garde sa propre copie de l'écran et la réimprime au prochain
  repaint qu'il décide, donc un effacement côté xterm seul remettait le texte qu'on venait de
  supprimer. Le tampon conservé part avec, sinon un redémarrage du renderer rejouerait l'effacé.
- **« Fermer les onglets vers la droite » s'arrête au bord du panneau.** `tabsAfter` ne regarde que le
  groupe de l'onglet visé, parce qu'avec une barre d'onglets par panneau « à droite de cet onglet » est une
  affirmation sur cette barre-là : ramasser les onglets d'un panneau voisin ferait qu'un geste de ménage
  atteint un panneau que personne ne regardait. Et les onglets non fermables sont **sautés, pas refusés** :
  le compte affiché dans le libellé est le nombre qui va vraiment partir, l'infobulle dit ce qui reste. Un
  item qui promet quatre fermetures et en fait trois, c'est un menu auquel on cesse de croire.
- **`Ctrl+Alt+W` est la seule exception assumée à la règle « pas de `Ctrl+Alt` »**, demandée
  explicitement. Elle ne tient que pour cette touche : `W` ne porte aucun caractère AltGr sur le clavier
  suisse français, donc la combinaison ne tape rien et il n'y a rien à masquer. Elle est comparée sur
  `event.code` et non `event.key` précisément parce que l'hypothèse porte sur la touche **physique** :
  sous un accord que certaines dispositions mappent, `key` devient le caractère composé et la comparaison
  cesserait silencieusement de matcher. Tout futur accord `Ctrl+Alt` doit être vérifié contre la
  disposition de la même façon, sinon il mange un caractère que quelqu'un tape pour de vrai.
- **Un raccourci ne ferme jamais un onglet non fermable.** `Ctrl+Alt+W` sort en silence sur un serveur qui
  tourne, comme son onglet sort en silence sans croix : `closable` est dérivé pour ça, et `Stop` reste le
  geste délibéré. Un raccourci capable de tuer un build par automatisme est exactement ce que cette règle
  empêche.
- **Git Bash se lance avec `-i`**, sinon les alias n'existent pas dans l'onglet.
- **Les profils sont sondés sur le disque** avant d'être proposés : une entrée de menu qui échoue au
  clic est pire que pas d'entrée.
- **Le renderer log est transféré au main** (`console-message` dans `window.ts`). Sans ça, une
  exception du renderer est invisible depuis le terminal qui lance l'app.
- **`closable` est dérivé, jamais stocké.** Un onglet `commit` est fermable même en cours, un shell
  toujours, un serveur de dev seulement une fois arrêté (`Stop` reste le geste délibéré). La première
  version rendait tout onglet de projet permanent, ce qui laissait un `commit` terminé coincé dans la
  barre sans moyen de le fermer.
- **Le bootstrap renvoie les sessions vivantes.** Le renderer redémarre sans le main à chaque
  rechargement à chaud : sans ça la barre d'onglets revenait vide et le shell de démarrage était
  rouvert à chaque fois, empilant des onglets identiques.
- **Renommer un onglet pose `renamed`**, ce qui empêche un relancement de la commande d'écraser le
  nom choisi.
- **Aucun rendu pendant un glisser.** Remplacer l'élément tiré en cours de geste annule le drag dans
  Chromium : le marqueur d'insertion est une classe posée sur les nœuds vivants, et la barre n'est
  reconstruite qu'une fois le nouvel ordre revenu du main. C'est aussi ce qui rend l'affichage
  autoritatif plutôt qu'optimiste.
- **Le marqueur d'insertion est un `box-shadow`, jamais une bordure** : une bordure changerait la boîte
  de l'onglet et décalerait toute la barre à chaque `dragover`, ce qui donne l'impression que les
  onglets fuient le curseur.
- **Changer la taille de police refait le `fit`.** La taille de cellule change, donc le nombre de
  colonnes et de lignes aussi : un pty resté sur l'ancienne géométrie coupe sa sortie à la mauvaise
  largeur. Les bornes vivent dans `TERMINAL_FONT_SIZE` (`contracts.ts`), lues par le clamp du store, le
  champ des réglages et le repli du pane, et le store les applique même à un fichier édité à la main.
  Une valeur illisible se corrigerait autrement dans une fenêtre de réglages devenue illisible.
- **`settings:update` diffuse, sauf pour les clés de `LOCAL_ONLY_KEYS`.** Ces clés naissent dans le
  dashboard et s'écrivent à chaque relâchement de séparateur ou changement d'onglet ; les renvoyer
  ferait reconstruire le tableau et le terminal en pleine geste. Tout le reste peut venir de la
  fenêtre de réglages et doit arriver.
- **`asPatch` vit dans `store/settings-patch.ts`, pas dans `ipc.ts`**, parce que `ipc.ts` importe
  Electron au niveau module et qu'un test l'exigerait alors aussi. Sa liste est **la** liste des clés
  que le renderer peut écrire, et une clé qui n'y est pas échoue en silence total : `pullsHeight`,
  `jiraHeight` et `activeStrip` y manquaient depuis la V2 alors que `renderer/main.ts` les envoyait,
  donc les hauteurs d'onglets et l'onglet actif ne survivaient pas à un redémarrage. D'où
  `test/settings-patch.test.ts`, qui verrouille la liste dans les deux sens.
- **Le tableau ne se redessine pas pendant une édition en place.** Il se rafraîchit à chaque cycle
  git, donc un rafraîchissement au milieu d'une frappe effacerait le champ.

## Actions configurables

- **Une action est de la configuration, pas du code.** `Run` et `Commit` n'existent plus en dur : la
  liste vit dans `settings.json` par projet, `defaultActions()` ne sert qu'à l'amorçage. Ne pas
  réintroduire de bouton câblé dans `project-table.ts`.
- **Au plus une action `server` par projet.** Une ligne porte un seul état serveur ; deux actions
  `server` auraient deux processus qui écrivent la même phase et le dernier à imprimer gagnerait.
  Invariant tenu à trois endroits : la sanitisation du store rétrograde les surnuméraires, le sélecteur
  de rôle rétrograde le précédent titulaire, et `validateActions` remonte une `error`.
- **Le rôle décide de tout le comportement**, pas le nom : `server` pilote l'état de la ligne, est
  remplacé par `Stop` pendant qu'il tourne, son onglet n'est pas fermable et sa sortie est parsée.
  `task` ne touche à rien et son onglet est fermable à tout moment.
- **L'id d'une action ne change jamais.** Il est dérivé du libellé à la création et clé l'onglet :
  le re-dériver au renommage orphelinerait le processus lancé depuis ce bouton même.
- **La commande est passée en un seul argument** au shell (`-ic`, `/c`, `-Command`). La découper sur
  les espaces casserait le premier chemin entre guillemets ou le premier `&&` écrit par l'utilisateur.
- **`Run` est amorcé sur `cmd`, `Commit` sur Git Bash**, et ce n'est pas cosmétique : un pty ne résout
  pas les shims `.cmd` (donc `npm` nu échoue) et bash n'expanse aucun alias en non-interactif (donc
  `commit` n'existe pas sans `-ic`). Voir `resolveActionCommand`.
- **`Run` est un REDÉMARRAGE, `Stop` est inchangé.** Un clic sur `Run` d'une action `server` arrête le
  processus encore vivant, **attend sa sortie**, puis relance. La règle d'avant (« déjà en cours : je
  rends l'onglet et je ne lance rien ») avait l'air inoffensive et faisait l'inverse : dans tout état où
  la ligne et les sessions se contredisaient, `Run` s'affichait et ne faisait **rien du tout**, sans que
  l'utilisateur puisse distinguer « rien à faire » de « c'est cassé ». Un redémarrage fait toujours
  quelque chose d'observable, et il *répare* cette contradiction au lieu de la subir. Corollaire :
  `canStart` a disparu du renderer et le bouton n'est plus jamais désactivé — son infobulle accusait un
  « serveur hors du dashboard », vestige de la sonde de port supprimée, et fausse dans l'état qui
  l'atteignait vraiment. Tant qu'un processus tourne, le bouton reste `Stop` : on peut donc toujours
  arrêter à la main, c'est `canStop` qui ne change pas.
- **Un `task` en cours n'est jamais redémarré**, seul un `server` l'est. `Commit` déclenche husky et
  lint-staged pendant une demi-minute : un second clic ne doit pas tuer un commit en vol. La règle vit
  dans `decideRerun`, pure et testée, parce qu'elle a trois branches dont deux se ressemblent.
- **L'attente avant relance n'est pas décorative.** `taskkill /T /F` est une *demande* qui rend la main
  bien avant que l'arbre soit tombé : relancer tout de suite ferait courir le nouveau serveur de dev
  contre le port que l'ancien tient encore, et l'échec parlerait de `address in use` pour une raison
  étrangère au code de l'utilisateur. Bornée à 8 s quand même (`RESTART_EXIT_TIMEOUT_MS`) : un processus
  qui refuse de mourir ne doit pas figer le bouton.
- **Une sortie de pty n'est rapportée que si le manager détient encore la session.** Sans ce garde dans
  `onExit`, l'exit d'une session déjà supprimée décrivait l'**ancien** processus tout en atterrissant
  sur la ligne du nouveau (`markExited` est indexé par projet) : la ligne passait `crashed` au-dessus
  d'un serveur bien vivant, et depuis cet état `Run` était affiché, actif, et définitivement inerte.
  La fenêtre est réelle et pas théorique : `close()` supprime l'entrée juste après avoir demandé le
  `taskkill`, et un redémarrage la supprime exprès. Reproduit par un test qui pilote un vrai pty
  (`test/terminal-manager.test.ts`, « exit reporting »), vérifié rouge sans le garde.
- **`Stop` se demande par projet, jamais par terminal.** `stopProjectServer` résout la session dans le
  main, qui est le seul côté à détenir à la fois les sessions et les rôles. Quand le renderer faisait
  ce travail (trouver l'action `server`, puis la session portant son id), les deux sauts renvoyaient
  `undefined` sans un mot dès que les deux côtés divergeaient : `Stop` devenait un bouton mort. La
  valeur de retour est un booléen exprès, pour qu'un « rien à arrêter » se voie dans les logs.
- **Une session tourne toujours avec un bouton capable de l'arrêter.** `TerminalManager.reconcile`
  ferme les onglets qu'un changement de config rend inatteignables : projet disparu, action disparue,
  ou action lancée comme `server` qui ne l'est plus (la ligne n'affiche alors ni `Run` ni `Stop` et le
  port resterait tenu). La règle vit dans le manager parce que le rôle au lancement y vit aussi.
- **`npm run dev` utilise `--watch`.** Sans ce drapeau, `electron-vite` recharge le renderer à chaud
  mais **pas** le main : on se retrouve avec un renderer neuf parlant à un main périmé. C'est
  exactement ce qui a fait croire à un `Stop` cassé après le passage de `command` à `actionId` : Run
  marchait par chance, Stop ne trouvait plus rien. Ne pas retirer ce drapeau.
- **Le port et le type se déduisent de la commande de l'action `server`**, plus d'un champ
  `startScript`. `scriptNameOf` suit un `npm run <x>` jusqu'au manifeste ; toute autre commande est
  interprétée telle quelle. Réintroduire un `startScript` recréerait deux endroits où se contredire.

## Onglet Pull requests

- **La bande du haut a quatre onglets, le terminal n'en dépend pas.** Seul le contenu de la bande
  change ; un onglet qui volerait la place du terminal irait contre tout le reste de cette app.
  Ajouter une vue, c'est une entrée dans `STRIP_TABS`, deux éléments dans `index.html`, une hauteur
  dans `AppSettings` — et cette hauteur doit être ajoutée à `asPatch` **et** à `LOCAL_ONLY_KEYS`,
  faute de quoi elle est jetée en silence (voir la note sur `settings-patch.ts`).
- **Il n'y a plus de barre de titre applicative.** Tout ce qu'elle portait (dernier rafraîchissement,
  `Rafraîchir`, notes, réglages, thème) vit dans la rangée d'onglets de la bande, qui était déjà une
  rangée de chrome : deux rangées de chrome au-dessus d'un terminal, c'en est une de trop quand le
  terminal est le sujet de la fenêtre. Le titre applicatif est parti avec, la barre de titre native le
  disant déjà. Bénéfice du déplacement : cette rangée est celle qui ne se replie jamais, donc les
  réglages et le rafraîchissement restent à un clic quand la bande est repliée.
- **`pane-resizer.ts` a survécu à la suppression sans être touché** : il mesure la distance de
  `#projects-pane` au haut du viewport avec `getBoundingClientRect` au moment où il en a besoin,
  jamais depuis une constante. Le panneau démarre simplement plus haut. Ne pas y introduire de
  hauteur d'en-tête en dur, c'est précisément ce qui aurait cassé ici.
- **La bande se replie sur sa rangée d'onglets** (`stripCollapsed`, bouton et `Alt+Shift+A`), pour
  travailler dans le terminal sans rien perdre de vue. **La rangée d'onglets, elle, ne se replie
  jamais** : un contrôle qui se cache lui-même ne laisse aucun moyen de revenir. Corollaire assumé et
  voulu : cliquer un onglet quand c'est replié déplie, parce que c'est le geste naturel pour « montre-
  moi ça ». Replier doit **effacer** la hauteur en ligne posée par `attachPaneResizer` (une classe ne
  bat pas un style inline), déplier la repose via le resizer pour qu'elle repasse par le même bornage,
  et le séparateur est masqué entre les deux : le glisser réécrirait une hauteur en travers du repli.
- **Le double-clic sur la rangée d'onglets replie aussi**, comme un double-clic sur une barre de titre.
  Il passe par `hitsInteractive`, et ce n'est pas un détail : sans ce garde, double-cliquer « Jira »
  sélectionnerait cet onglet **et** replierait le panneau qu'on demandait à voir. Le chevron reste : le
  double-clic est le geste qu'on trouve quand on connaît l'app, pas celui qui doit être découvrable.
- **Chaque onglet a sa hauteur** (`projectsHeight`, `pullsHeight`) : un tableau de quatre lignes et une
  liste maître-détail n'ont pas les mêmes besoins. `attachPaneResizer` renvoie un `setHeight` pour que le
  changement d'onglet applique la bonne, sans dupliquer le bornage ailleurs.
- **Un `display` posé par une classe écrase le `[hidden]` du navigateur.** `.pulls` est en `display: grid`,
  donc il a fallu un `.pulls[hidden] { display: none }` explicite : sans lui les deux vues s'empilaient à
  l'écran. Même piège que `.terminal__view`.
- **Un clic sur une ligne de PR ouvre la PR dans le navigateur**, et le terminal du dépôt a son propre
  bouton. Les deux gestes étaient inversés jusqu'à ce que l'usage tranche : devant une liste de pull
  requests, le réflexe est d'aller lire la PR, et le terminal est le geste délibéré. Le garde
  `hitsInteractive` est ce qui empêche le bouton d'ouvrir aussi le navigateur en sortant de la ligne.
- **Le bouton « Ouvrir <CLÉ> » de l'onglet Jira pointe sur `/browse/<CLÉ>`**, jamais sur un chemin
  `/jira/software/...`. Un chemin de board exige l'id numérique du board *et* le style du projet, deux
  choses que l'app n'a pas : vérifié sur le site réel, `PROJ` est **team-managed** (`style: next-gen`,
  donc `/jira/software/projects/...`) alors qu'un projet company-managed utilise
  `/jira/software/c/projects/...`. Deviner entre les deux donnerait un 404 une fois sur deux.
  `/browse/<CLÉ>` est la seule forme que Jira Cloud résout pour tous les types de projet. Épinglé par
  un test pour que personne ne l'« améliore » en chemin de board.
- **Les dépôts sont déduits des projets** via `git remote get-url origin` (`readRemoteSlug`), avec une case
  `followPulls` par projet. Pas de seconde liste à tenir à jour ; corollaire assumé, un dépôt non cloné ne
  peut pas être suivi.
- **Un seul appel `gh pr list` par dépôt**, filtrage « les miennes » en local sur les `login`. Filtrer côté
  GitHub aurait coûté deux appels par dépôt, sa syntaxe de recherche ne sachant pas faire ce `OR`. La
  charge utile complète est donc en main, et c'est **exactement** ce qui a rendu la seconde sous-vue
  gratuite : ne pas réintroduire de filtre côté GitHub pour l'une ou pour l'autre.
- **Deux sous-onglets, « Les miennes » et « Toutes »**, et pas un filtre élargi : les deux comptes
  diffèrent, donc une liste unique devrait choisir lequel afficher dans la colonne des dépôts — et ce
  compte est la réponse d'un coup d'œil que l'onglet existe pour donner. Les deux comptes sont donc
  **sur les sous-onglets**, parce que « 0 miennes / 3 toutes » répond à « ce dépôt est calme ou je n'y
  suis pas ? » sans changer de vue. Le compte de la colonne suit la sous-vue active, sinon la pastille
  contredit la liste à côté d'elle. `pullScope` est persisté (donc dans `asPatch` **et**
  `LOCAL_ONLY_KEYS`, voir la note sur `settings-patch.ts`).
- **`.subtab` est partagé par l'onglet Git et l'onglet PR.** C'était `.git__view`, renommé : une classe
  nommée d'après un panneau est une classe que le panneau suivant recopie au lieu de la réutiliser. Même
  raison que `.icon-button--row`.
- **L'auteur s'affiche dès qu'il n'est pas l'utilisateur**, pas seulement dans « Toutes » : une PR en
  attente de votre relecture dit « à relire » sans dire de qui, ce qui est la première chose qu'on veut
  savoir. Masqué quand c'est la vôtre, pour la raison qui fait disparaître la colonne « assigné » dans
  « Mes tickets ».
- **Trois pièges du payload, tous rencontrés en vrai** : un `reviewDecision` vide veut dire « aucune review
  requise » et **n'est pas** une approbation ; une review demandée à une **équipe** n'a pas de `login` et
  doit être ignorée sans planter ; un `statusCheckRollup` vide est `no-checks`, jamais `passing`.
- **`PullMonitor` est une boucle à part**, cadence en minutes (`pullsPollSeconds`, 180 s par défaut). Elle
  est reconstruite par `reloadProjects` comme le monitor de projets, parce qu'elle indexe son état et ses
  remotes résolus par projet.
- **`verdictFor` est partagé** avec le service de checks : deux endroits décidant ce que « vert » signifie
  finiraient par ne plus être d'accord.
- Les cadences de sondage ne sont pas dans l'UI, comme `gitPollSeconds` et `checksPollSeconds` : elles
  s'éditent dans `settings.json`.

## Onglet Jira

- **Le jeton d'API ne va jamais dans `settings.json`.** Il vit chiffré par `safeStorage` (DPAPI sous
  Windows, lié au compte) dans `jira-token.bin`. Si le chiffrement est indisponible, `SecretStore.write`
  **refuse** d'écrire plutôt que de retomber en clair : un secret écrit en clair parce que le coffre était
  fermé, personne ne le remarque.
- **Le jeton ne remonte jamais vers le renderer.** Le formulaire reçoit `hasToken: boolean`, jamais la
  valeur ; un champ vide à l'enregistrement veut dire « garde celui qui est stocké », pas « efface ».
- **L'étape d'un ticket vient de `statusCategory`, pas du nom du statut.** Les noms sont propres à chaque
  projet et renommés à volonté (« En review », « Ready for QA ») ; seule la catégorie (`new`,
  `indeterminate`, `done`) veut dire la même chose partout. Le nom reste ce qui est **affiché**, parce que
  c'est le mot que l'équipe emploie.
- **`sprint in openSprints()`** laisse Jira répondre lui-même à « quel est le sprint courant », au lieu de
  chercher un board puis son sprint actif.
- **Deux endpoints de recherche possibles.** Jira Cloud a remplacé `POST /rest/api/3/search` par
  `GET /rest/api/3/search/jql`, et les instances migrent à leur rythme. Le service essaie le nouveau, se
  rabat une fois sur l'ancien sur 404/410, puis retient la réponse. Ne pas « simplifier » en n'en gardant
  qu'un sans avoir vérifié sur le site réel.
- **Le bouton « Tester » lance une vraie recherche**, pas un ping : seule une requête réelle valide à la
  fois les identifiants et les clés de projet, qui sont ce qui échoue en pratique.
- Rien n'est interrogé tant que site, email et jeton ne sont pas tous les trois renseignés : une install
  non configurée ne fait aucune requête.
- **Les points d'estimation ne sont pas affichés** : leur champ (`customfield_xxxxx`) varie d'un site à
  l'autre et il faudrait le découvrir via `/rest/api/3/field`. À ajouter si le besoin se confirme.
- **Les transitions se lisent à l'ouverture du menu**, jamais en cache : un workflow décide quels
  mouvements sont légaux depuis le statut courant, donc une liste mémorisée proposerait des mouvements que
  Jira refuserait ensuite. Une requête par clic droit, c'est le bon prix pour ne jamais mentir.
- **Une transition est libellée par le statut d'arrivée**, pas par son propre nom : le nom est un verbe
  (« Start progress ») alors que l'utilisateur choisit une destination.
- **« M'assigner » passe par l'`accountId` du compte du jeton** (`/rest/api/3/myself`), jamais par un
  email : les emails sont masqués par la confidentialité sur beaucoup de sites, et l'id garantit que
  l'action ne peut viser personne d'autre.
- **L'ordre d'affichage met « en cours » en tête, et c'est un tri LOCAL stable.** `orderIssues` trie sur
  le `stage` (donc sur `statusCategory`, même raison que `presentStage` : « En review » et « Ready for QA »
  doivent compter comme du travail en cours) et sur cette seule clé, pour que l'`ORDER BY` du JQL reste
  l'ordre **à l'intérieur** de chaque groupe. Sans cette stabilité, il y aurait deux autorités sur l'ordre
  et la seconde serait invisible. Fait localement et pas en JQL : `ORDER BY statusCategory DESC` se lit
  « en cours puis à faire » **uniquement parce que** les deux recherches excluent Done, donc il
  s'inverserait en silence le jour où quelqu'un élargit le scope, et la collation des catégories de Jira
  n'est pas vérifiable depuis ici.
- **Les écritures rafraîchissent tout de suite** (`afterJiraWrite`) : la ligne qu'on vient de changer doit
  montrer son nouvel état sans attendre le tour de boucle de cinq minutes.
- **Les lignes de tickets sont une grille**, pas une ligne flex : leurs badges sont conditionnels, donc en
  flex aucune ligne n'était d'accord sur l'emplacement du statut. L'assigné vient avant le statut, et la
  colonne disparaît dans « Mes tickets » où chaque ligne porterait le même nom.
- **Le filtre par assigné et le tri des colonnes ne sont PAS persistés**, contrairement à `pullScope`.
  Un filtre caché qui revient au lancement suivant, c'est une liste qui cesse silencieusement de montrer
  la moitié du sprint, avec pour cause une liste déroulante que personne ne se souvient d'avoir réglée.
  Le scope d'un onglet PR est une préférence ; un filtre est une question posée une fois. Le filtre est
  aussi **remis à zéro au changement de vue** : « Mes tickets » n'a pas de colonne assigné, donc un
  filtre reporté y masquerait des lignes sans offrir le moyen de le voir ni de l'enlever.
- **Un tri par colonne REMPLACE l'ordre par défaut, il ne l'affine pas.** Trier par nom *à l'intérieur*
  du groupe « en cours » garderait l'habitude de l'onglet, mais ferait mentir le tri : qui a cliqué
  « Assigné » attend que les noms se suivent sur toute la liste. Une seule autorité sur l'ordre à la
  fois, celle qu'on a demandée. Corollaire : le cycle d'un en-tête a **trois** états (croissant,
  décroissant, retour au défaut), sinon il n'y a plus de chemin de retour vers « en cours d'abord ».
- **Le sens du tri s'applique à la comparaison, jamais en inversant le tableau.** Inverser inverse aussi
  les ex æquo : deux tickets au même statut échangeraient leur place à chaque changement de sens, ce qui
  donne l'impression que la liste brasse des lignes que personne n'a triées.
- **Les clés de tickets se comparent sur leur nombre, pas comme du texte.** `localeCompare` place
  `PROJ-1000` avant `PROJ-999`. Invisible jusqu'à ce qu'un projet passe une puissance de dix, ce que tout projet a
  fait depuis longtemps.
- **`ASSIGNEE_NONE` est un caractère de contrôle**, pas le mot « none » : les valeurs de ce filtre sont
  des noms affichés lus dans Jira, et tout sentinelle lisible est un nom que quelqu'un peut porter. `''`
  voulant déjà dire « tout le monde », le non-assigné a besoin d'une valeur qui ne peut pas collisionner.
- **L'en-tête triable est DANS le défilement, en `position: sticky`.** Sorti dans une boîte à part, il se
  décalerait de la largeur de l'ascenseur dès que la liste déborde, et une colonne mal alignée avec ses
  valeurs est pire que pas d'en-tête. Il réutilise la grille `.issue`, seule façon qu'un libellé reste
  au-dessus de la colonne qu'il nomme.
- **« Créer une branche » lance l'alias `dev <TICKET>`, jamais une commande construite côté renderer.**
  Le canal prend un projet et une clé ; le main assemble `dev <KEY>` après avoir validé la clé contre
  `ISSUE_KEY_PATTERN`. C'est le seul endroit de l'app où une saisie venue du renderer atteint un shell,
  donc le motif est ancré et volontairement étroit : lettres, tiret, chiffres. Il exige aussi un **bash
  interactif** (`resolveBashProfile`), parce que `dev` est un alias de `.bashrc` : pas de bash → pas de
  commande et un message qui nomme le shell manquant, plutôt qu'un `command not found` dans un onglet
  qui a l'air d'avoir marché.
- **Le choix du projet est un SECOND menu contextuel au même endroit**, pas une modale ni un vrai
  sous-menu. Une modale est exclue par principe ici (un `mousedown` dedans relâché dehors déclenche un
  `click` sur l'ancêtre commun : le bug qui a fait retirer la modale des réglages). Un vrai sous-menu
  demanderait minuteries de survol, retournement aux bords et modèle clavier, soit un framework de menus
  pour une liste de quatre dépôts. Et une liste plate « Créer une branche dans X » dans le premier menu
  pousserait les transitions hors de l'écran dès dix projets. Le dernier projet utilisé est en tête et le
  dit ; il est **session-local**, comme un raccourci et non comme un réglage.
- **`context-menu.ts` n'a aucun effet de bord à l'import.** Ses écouteurs de fermeture sont posés à la
  première ouverture : au chargement du module, deux fichiers de tests sans DOM cassaient.
- **Pas de placeholder d'exemple dans les réglages.** Un exemple grisé se lit comme une valeur déjà
  enregistrée ; là où un placeholder subsiste, c'est une valeur déduite, et il est en italique très pâle.

## Panneau Notes

- **La fenêtre est une rangée sous la barre du haut** (`.app__body` en flex row, `.workspace` en
  colonne, l'`<aside>` à droite). La barre du haut reste **hors** de cette rangée, et c'est toute
  l'astuce : `#projects-pane` garde sa distance au haut du viewport, donc `resolvePaneHeight`,
  `clampPaneHeight` et `test/pane-resizer.test.ts` sont inchangés. Ouvrir le panneau ne change **que
  la largeur** de l'espace de travail.
- **`min-width: 0` sur `.workspace` n'est pas cosmétique** : la largeur min-content de l'xterm est
  grande et un élément flex refuse de rétrécir en dessous, donc sans ça le panneau part hors écran.
  Et `.notes[hidden] { display: none }` explicite, même piège que `.pulls`.
- **Le `resize` de fenêtre ne se déclenche pas quand le panneau s'ouvre**, la fenêtre n'ayant pas
  changé de taille. Il faut donc `terminal.refit()` explicitement à trois endroits : la bascule, le
  glissement du séparateur, et l'application de la largeur mémorisée au démarrage.
- **`WORKSPACE_RESERVE = 480`** dans `side-resizer.ts` : le panneau ne peut jamais réduire le
  terminal en dessous de 480 px. L'invariant devient un bornage, pas un espoir. `side-resizer.ts` est
  un module à part et **pas** une généralisation de `attachPaneResizer` : ce dernier code en dur l'axe
  vertical, et sa direction est justement ce que verrouille son test.
- **Pas de modale ni de superposition.** Une sélection de texte commencée dans l'éditeur et relâchée
  au-dehors déclencherait un `click` sur l'ancêtre commun : c'est exactement le bug qui a fait
  retirer la modale des réglages, et un éditeur de texte en est le cas le plus exposé.
- **Le nom de fichier est un horodatage, pas le titre.** Le titre *est* la première ligne du corps,
  donc un nom dérivé du titre serait renommé à chaque frappe sur la ligne 1, avec la course `EPERM`
  de Windows à chaque fois. L'id sert aussi de garde contre la traversée de chemin, validé à chaque
  entrée. Et il **doit garder son `T`** : `NOTE_ID_PATTERN` l'exige, et l'avoir retiré faisait
  échouer `isNoteId`, sortir `update()` en silence et perdre toutes les frappes.
- **Pas de frontmatter.** Tout ce qu'il porterait est déjà gratuit (`mtime`, taille, première ligne),
  et le round-trip serait une transformation sur la seule chose qu'il ne faut jamais perdre.
- **L'anti-rebond de 300 ms vit dans le main, pas dans le renderer.** Le renderer meurt plusieurs
  fois par minute sous `--watch` ; avec le minuteur côté main, un plantage en pleine phrase ne perd
  rien, et le quit a un seul tampon à vider. `openNote` **vide la file puis lit**, en un seul
  handler, pour que l'ordre ne dépende pas de la discipline du renderer.
- **Supprimer jette d'abord le tampon en attente**, sinon une écriture différée ressuscite le fichier
  200 ms plus tard. C'est le bug le plus probable du store, il a son test.
- **`before-quit` est synchrone** : `preventDefault()`, puis `flush().finally(() => app.quit())`, avec
  un `return` anticipé sans lequel les moniteurs s'arrêteraient sur une fermeture annulée.
- **`notesStore.refresh()` est attendu AVANT la création de la fenêtre.** Fait après le chargement de
  la page, le `bootstrap` du renderer le devance, revient avec une liste vide, et un panneau rouvert
  au démarrage affiche ses notes sans en sélectionner aucune.
- **`NotesState` ne transporte jamais le corps d'une note.** C'est ce qui rend un rafraîchissement de
  liste incapable, *par construction*, d'écraser le texte en cours de frappe. La liste est poussée,
  le corps est tiré.
- **Pas de `fs.watch`** : il se déclencherait sur nos propres écritures et se battrait avec l'éditeur,
  et sur un dossier synchronisé il tournerait en boucle.
- **L'éditeur est repris de `oxum-prompt-editor`**, pas réécrit. Les `tokens.css` des deux repos sont
  identiques au byte, y compris les `--md-*` que lit `markdown-theme.ts`, donc les blocs CSS se
  copient sans retouche. Trois divergences assumées, marquées dans le code : `@codemirror/language-data`
  écarté (~1,4 Mo sur 120 chunks pour de la prose), pas de compartiment de taille de police, et un
  `loadDocument` qui fait un **`setState`** et non un `replaceAll` — sinon l'historique d'annulation
  survit au changement de note et `Ctrl+Z` dans la note B y tape le contenu de la note A.
- **La CSP n'a pas eu à changer** : `style-src 'self' 'unsafe-inline'` préexistait, et c'est ce que
  CodeMirror utilise pour injecter ses `<style>`. `script-src 'self'` reste intact, il n'a pas besoin
  de `unsafe-eval`. Import statique et pas dynamique : un chunk émis à la demande poserait une
  question non vérifiée sur `script-src` en `file://`.
- **`.cm-editor { user-select: text }`** est obligatoire : le `body` de cette app est en
  `user-select: none` et seul `.terminal__surface` y dérogeait, donc sans cette règle le texte d'une
  note n'est pas sélectionnable à la souris.
- **`Escape` n'est pas dans le keymap CodeMirror** mais sur le panneau, en phase de bulle : le keymap
  tourne en `Prec.highest`, donc un `Escape` là battrait celui de l'extension de recherche et
  fermerait le panneau en laissant la barre de recherche ouverte derrière.
- **`Alt+Shift+N`** bascule le panneau, comme les `Alt+Shift+{D,B,W}` du terminal et pour les mêmes
  raisons : phase de capture, pas de `Ctrl+Alt` (AltGr en suisse français), une lettre et pas un
  chiffre, et un garde sur `event.repeat`.

## Onglet Git

- **La lecture est tirée, pas poussée.** Aucun moniteur derrière cet onglet : une seule ligne est
  affichée à la fois, et sonder branches, historique et statut de tous les projets coûterait plusieurs
  fois le poll git de la bande pour ce que personne ne regarde. Le renderer demande quand il affiche
  l'onglet, quand la sélection change et après chaque écriture, c'est-à-dire exactement quand la
  réponse a pu changer. Le battement de cœur, lui, est le `RowsChanged` du poll git : c'est le même
  arbre de travail que décrit cet onglet.
- **Les écritures rapides passent par `execFile`, le commit par un onglet du terminal.** Ce n'est pas
  une incohérence, c'est la seule ligne de partage qui tienne : un checkout ou un `git add` est
  instantané et son résultat se lit dans la bande, alors qu'un commit déclenche `husky` et
  `lint-staged`, qui peuvent tourner une demi-minute et impriment tout ce qui explique un refus. Lancé
  en silence, ça se réduit à une ligne d'échec ; lancé dans un onglet, ça se regarde comme depuis un
  shell, ce que demande de toute façon la règle « toute action finit dans un onglet ».
- **Le message de commit passe par un fichier, jamais par `-m`.** Deux raisons indépendantes : un
  message est multi-ligne par convention, donc `-m` ferait décider au formulaire de la forme du
  message ; et le message atteint git comme des **octets sur le disque**, donc rien dedans ne peut
  être lu comme une option. Un sujet commençant par `-`, ça existe, et son test aussi.
- **Le fichier de message est conservé après le commit.** Il ne coûte rien, et quand un hook refuse le
  commit c'est la seule copie survivante de ce qui a été tapé : l'effacer transformerait un hook en
  échec en travail perdu.
- **L'onglet de commit porte un `actionId` réservé, `git:`.** Il est lié à un projet mais n'est **pas**
  une de ses actions configurées : cherché dans la liste des actions il ne trouve rien, donc sans le
  cas d'exemption dans `isUnreachable` chaque enregistrement des réglages tuerait un commit en plein
  hook. Le cas est testé, comme les quatre autres de cette fonction.
- **`run-git.ts` est le seul endroit qui appelle git.** `execFile` avec un tableau d'arguments et
  **jamais de shell** : un nom de branche ou un chemin ne peut donc pas être lu comme de la syntaxe
  shell. `git-service.ts` a été replié dessus plutôt que de garder son propre lanceur, sinon il y
  aurait deux réponses à « comment on appelle git ici ». Deux budgets, pas un : 8 s en local, 120 s
  pour le réseau, un push par VPN n'étant pas une opération de huit secondes.
- **`git status --porcelain -z`, jamais sans `-z`.** Sans lui git **échappe** tout chemin non-ASCII
  (`"src/cr\303\251ation.ts"`) selon `core.quotepath`, qu'il faudrait désassembler, et sépare les
  enregistrements par des retours à la ligne qu'un chemin peut contenir. Avec `-z` les chemins sont
  bruts. Corollaire à ne pas perdre : un renommage occupe **deux** champs, et ne pas consommer le
  second ajoute un fichier fantôme et décale tout le reste.
- **Les colonnes index et arbre de travail ne sont jamais fusionnées.** `MM` (indexé puis remodifié)
  est le cas qu'un état unique écraserait, et c'est celui où la case à cocher mentirait sur ce que le
  commit contient. `isStaged` vit dans `shared/git-changes.ts` parce que le renderer coche la case et
  que le main garde le commit : deux définitions de « indexé » finiraient par diverger, exactement
  comme `verdictFor` côté checks. Et `?` n'est **pas** un état indexé, ce qu'un simple `!== ' '` rate.
- **Dans un diff, les en-têtes se testent avant les marqueurs.** `---` et `+++` commencent par les
  caractères de suppression et d'ajout : lus comme du contenu ils consomment deux numéros de ligne et
  décalent tout ce qui suit. Ils sont donc reconnus **avec leur espace finale**, ce qui les distingue
  d'un `----` supprimé dans un Markdown, cas réel et testé.
- **`git diff --no-index` sort en 1 dès qu'il trouve une différence.** C'est documenté et ce n'est pas
  un échec : c'est le seul moyen de voir le contenu d'un fichier non suivi, et traiter ce code retour
  comme une erreur afficherait un message d'erreur pour chaque nouveau fichier.
- **`pull` est `--ff-only`, volontairement.** Un merge ou un rebase peut s'arrêter sur un conflit, et
  cet onglet n'a rien à proposer à quelqu'un debout au milieu d'un rebase : refuser de le commencer
  est la seule issue qu'il puisse honnêtement expliquer. Une branche divergée, c'est le terminal.
- **`push` devient `-u origin <branche>` quand il n'y a pas d'upstream**, relu au moment du clic et
  non d'après ce que le renderer avait vu : c'est le premier push de toute branche neuve, et une
  réponse périmée en ferait un refus incompréhensible.
- **Le checkout ne stashe rien et ne force rien**, et il est un **bouton**, pas un clic sur la ligne :
  changer ce qu'il y a sur le disque ne doit pas être à un clic perdu dans une liste. Un checkout
  bloqué par des modifications locales échoue, et git dit lui-même quels fichiers gênent. Un stash
  automatique déplacerait du travail là où personne n'a demandé ni regardé.
- **Le nom d'une branche est validé par `git check-ref-format`**, pas par une expression régulière à
  nous : les règles de git sont plus subtiles qu'elles n'en ont l'air (pas de `..`, pas de `.lock`
  final, pas de `@{`) et une approximation refuse un nom légal ou laisse passer un illégal que git
  rejettera plus tard en parlant d'autre chose.
- **Le panneau se reconstruit entier à chaque poll**, donc le brouillon de message, le nom de branche
  en cours de frappe et la sélection vivent dans `App`, pas dans le DOM. Et le rafraîchissement est
  **suspendu tant qu'un champ a le focus** (`gitEditing`), même garde et même raison que le renommage
  en place du tableau.
- **Le sujet d'un commit prime sur ses refs.** `flex: none` sur le badge de refs était faux et ça s'est
  vu au premier vrai merge : `HEAD -> main, origin/main, origin/HEAD` ne rétrécissait pas et laissait
  au sujet **un caractère**. Les refs sont du contexte, elles rétrécissent d'abord et sont plafonnées ;
  la liste complète reste dans l'infobulle.
- **Un chemin se tronque à gauche, un sujet à droite.** La fin de
  `src/app/feature/x.component.ts` est ce qui distingue deux fichiers ; le début de `PROJ-1601-…` ou de
  `feat: …` est ce qui distingue deux branches ou deux commits. D'où deux classes et pas une.
  `direction: rtl` seul ne suffit pas : sans `unicode-bidi: plaintext`, la direction de la boîte
  gouverne aussi le texte et réordonne la ponctuation de tête ou de queue.
- **Le diff est plafonné à 4000 lignes, et il le dit.** Un lockfile généré fait des dizaines de
  milliers de lignes, et un élément par ligne est ce qui fige la bande. Un diff coupé en silence se lit
  comme un diff complet, donc la troncature est annoncée dans la vue.
- **La colonne diff s'ouvre sur le premier fichier modifié.** C'est la raison d'être de la troisième
  colonne, et arriver sur une colonne vide demande de cliquer avant que l'onglet ne dise quoi que ce
  soit. Uniquement quand rien n'est sélectionné, donc ça ne peut jamais arracher la vue à un fichier en
  cours de lecture, et uniquement sur la vue Changements : présélectionner un commit lancerait un
  `git show` pour une liste que personne n'a ouverte.
- **`defaultTargetFor` décide du côté affiché**, partagée par le clic et par la présélection : l'arbre
  de travail quand il y a quelque chose, l'index sinon. C'est aussi le seul choix jamais vide, `git
  diff` ne rendant rien sur un fichier dont tout est indexé. Le bouton index/disque n'apparaît que pour
  un fichier qui est les deux à la fois, le seul cas où la question a deux réponses.
- **Un menu ouvert au clic GAUCHE doit couper la propagation.** `showContextMenu` se referme sur tout
  `click` atteignant `document`, ce qui est correct pour tous ses autres appelants : ils ouvrent depuis
  `contextmenu`, et un clic droit n'émet aucun `click`. Le bouton `⋯` est le premier menu ouvert au
  clic gauche, et sans `event.stopPropagation()` le clic d'ouverture continuait jusqu'à l'écouteur de
  fermeture et refermait le menu dans le même tick : un bouton parfaitement mort à l'usage, et
  invisible en test.
- **Fetch, pull et push sont AUSSI des icônes au bout de la rangée d'onglets.** Elles y sont et pas
  dans l'en-tête parce que c'est la rangée des contrôles : l'en-tête est une ligne d'état (branche,
  écart amont) et y mêler des verbes est ce qui la rendait illisible. `align-self: center` et une
  hauteur inférieure aux onglets, exprès : une icône aussi haute qu'un onglet se lit comme un
  quatrième onglet, or ces trois-là *font* quelque chose alors qu'un onglet change seulement de vue.
- **La pointe d'une flèche se dimensionne sur l'icône RENDUE, pas sur le viewBox.** La première
  version de l'icône fetch dessinait sa pointe sur 1,3 unité d'une boîte de 16, soit environ un pixel
  par barbe une fois rendue à 14 px : elle sortait en moustache et l'icône se lisait comme un « C ».
  Vu en vrai, à la loupe, corrigé à 2,2 unités.
- **Les actions du dépôt sont un menu, pas des boutons.** Fetch, pull, push et « ouvrir un terminal
  ici » occupaient quatre boutons sur la ligne d'en-tête ; une bande de statut se lit d'un coup d'œil,
  et quatre contrôles en concurrence avec le nom de branche, ce n'est plus un coup d'œil. Clic droit
  sur la ligne d'en-tête, plus un bouton `⋯` gardé pour la raison qui a fait garder le chevron à côté
  du double-clic de repli : le geste de connaisseur n'a pas à être le geste découvrable, mais il faut
  qu'il y en ait un. Le menu est **reconstruit à chaque ouverture**, comme les transitions Jira : ses
  libellés dépendent de l'état (`Push` devient « Push et publier la branche » sans upstream).
- **`gitPanelState()` et `gitPanelActions()` sont extraits pour ça.** Le menu a besoin exactement du
  même instantané que le panneau ; deux endroits qui l'assemblent finiraient par ne plus être d'accord,
  et la panne serait un menu proposant un `Push` que le panneau a déjà désactivé.
- **La frontière liste/diff est déplaçable, et c'est la largeur de la LISTE qui est stockée.** La
  colonne non stockée absorbe chaque redimensionnement de fenêtre : de la largeur en trop vaut quelque
  chose pour un diff (les longues lignes de code) et rien pour une colonne de chemins. Le séparateur
  écrit une **custom property** sur la grille et non une largeur sur la colonne : une piste de grille
  ne se dimensionne pas depuis un glisser, la propriété qui la dimensionne, si. Et contrairement aux
  deux autres séparateurs de l'app, celui-ci **ne refait pas le `fit` du terminal** : il déplace une
  frontière *interne* à la bande, la boîte du terminal ne bouge pas.
- **`git-split.ts` est un troisième module de séparateur, pas une généralisation.** Même raisonnement
  que pour `side-resizer.ts` : trois axes différents (hauteur ancrée en haut, largeur ancrée à droite,
  largeur ancrée à gauche dans un conteneur), et la direction d'un resizer est précisément ce qui
  s'écrit à l'envers — ça s'est déjà produit ici. Les trois sont donc des fonctions pures testées.
- **`gitHeight` par défaut à 460**, la plus grande des quatre. Trois colonnes finissant par un diff,
  c'est l'onglet où l'on cesse de jeter un œil pour se mettre à travailler ; 250 px montreraient quatre
  lignes de diff.
- **L'icône terminal d'une ligne de dépôt est la SŒUR de la ligne, pas son enfant**, et c'est toute la
  raison d'être du conteneur `git__repo-line`. La ligne est un vrai `<button>` (donc atteignable au Tab et
  qui répond à Entrée) et nicher un bouton dans un bouton est du HTML invalide que les navigateurs
  réarrangent en silence — la raison même pour laquelle une ligne de PR est un `div`. Ici la ligne garde sa
  sémantique et l'icône est un contrôle de plein droit. Conséquence voulue : ouvrir un terminal ne
  **sélectionne pas** le dépôt, donc ça ne déclenche aucune lecture git d'un repo que personne n'a ouvert.
  Elle n'est pas désactivée par `state.busy`, comme la même entrée du menu du dépôt : elle ne lance aucune
  commande git.
- **Le cherry-pick est au CLIC DROIT sur un commit, jamais un bouton de ligne.** C'est le même jugement
  que le bouton `Checkout` enregistre dans l'autre sens : un checkout change le disque, donc il ne doit
  pas être atteignable par un clic perdu dans une liste ; un cherry-pick change l'**historique**, donc il
  ne doit pas être atteignable du tout sans l'avoir demandé. La colonne d'historique est défilée et
  cliquée toute la journée pour lire des diffs. Le menu est reconstruit à chaque ouverture, comme celui
  du dépôt : la branche cible est dans les libellés.
- **Un sha se valide, faute de `--` derrière quoi se cacher.** `cherry-pick` prend des révisions et pas
  des chemins, donc il n'y a pas de séparateur pour neutraliser une valeur commençant par `-` : la garde
  est le motif hexadécimal lui-même. Ça ne coûte rien, ces shas venant de notre propre `git log`.
- **`GitRepoState.sequencer` est la moitié obligatoire du cherry-pick.** Un cherry-pick en conflit
  s'arrête avec `CHERRY_PICK_HEAD` sur le disque, et depuis cet état *tous* les autres boutons de
  l'onglet échouent pour une raison qui n'a rien à voir avec ce qu'on a cliqué. L'état est donc lu, dit
  en pastille `error` à côté de la branche, et le menu du dépôt propose la sortie (`--abort` avant
  `--continue` : on ouvre ce menu parce que quelque chose a mal tourné, et `--abort` est celui qui ne peut
  pas empirer les choses). Les marqueurs sont lus via `git rev-parse --absolute-git-dir` et **jamais** en
  joignant `.git/` au chemin du dépôt : dans un worktree, `.git` est un *fichier*, donc la version naïve
  répondrait « rien en cours » pour tous les worktrees. Merge, revert et rebase sont lus au même prix,
  et un dépôt laissé au milieu d'un rebase trompe exactement autant.
- **`--continue` tourne avec `GIT_EDITOR=true`.** Sans ça git ouvre l'éditeur de `core.editor` pour
  confirmer le message, et un éditeur ouvert par un `execFile` silencieux est une commande qui ne rend
  jamais la main : l'appel resterait là jusqu'au timeout, dépôt toujours au milieu de l'opération et rien
  à l'écran pour le dire. L'orthographe du drapeau varie selon l'opération (`--no-edit` existe pour
  certaines), la variable d'environnement marche pour toutes.
- **Un stash se désigne par son SHA, jamais par `stash@{n}`.** Le ref est une **position** dans une liste
  qui se renumérote à chaque `drop` et chaque `pop` : un ref lu il y a trente secondes peut nommer une
  autre entrée au moment du clic, et un `drop` sur la mauvaise entrée est du travail perdu que rien ici
  ne sait retrouver. `applyStash` relit donc la liste et y cherche le sha ; une entrée disparue est
  **refusée**, pas approximée. Le ref reste affiché parce que c'est ce que `git stash` imprime et ce
  qu'on retaperait dans un terminal.
- **`--include-untracked` est un choix, décoché par défaut.** Un checkout refuse déjà d'écraser des
  modifications suivies : ce sont celles-là qu'un stash sert à mettre de côté. Les fichiers neufs, un
  checkout les emporte sans broncher, donc les balayer par défaut déplacerait du travail que personne
  n'a demandé de déplacer. Piège vérifié qui va avec : avec **uniquement** des fichiers non suivis,
  `git stash` ne sauve rien du tout et sort quand même en 0 — donc « succès » n'est pas « quelque chose a
  été stashé », et le message rendu est la phrase de git elle-même.
- **Le diff d'un stash passe par `git stash show -p`, pas par `git show`.** Une entrée de stash est un
  commit de merge, et `git show` n'imprime *rien* pour un merge sans demander un diff combiné :
  réutiliser la branche « commit » afficherait un diff vide pour chaque stash, ce qui se lit « rien de
  stashé ». Corollaire : la cible de diff `stash` porte le sha, comme les écritures.
- **Les actions d'un stash sont un menu, pas des boutons.** `pop` et `drop` *retirent* l'entrée, et
  `drop` la retire sans que rien à l'écran sache la ramener : ni l'un ni l'autre n'a sa place sur une
  ligne qu'on clique aussi pour lire un diff. Et le libellé de `drop` dit que c'est définitif — le
  reflog garde le commit un temps, mais **cet onglet** ne sait pas le retrouver, et promettre une
  récupération qu'on n'offre pas serait pire que d'annoncer la perte.
- **Ce que cet onglet ne fait toujours pas, et pourquoi** : pas de résolution de conflit, pas de rebase
  interactif, pas de staging par morceaux. La raison n'a pas changé : ils laissent le dépôt dans un état
  intermédiaire que cette bande ne saurait ni montrer ni terminer, et les conflits restent affichés en
  `error` dans la liste plutôt que noyés parmi les modifications, précisément pour renvoyer au terminal.
  Le **stash**, lui, a quitté cette liste, et l'argument mérite son épitaphe : il visait le *geste* dont
  personne ne voulait (un stash automatique derrière un checkout) et pas l'objet — un stash est un
  instantané nommé, listé, complet, et en créer un laisse un arbre propre. Ce qui a dû venir avec la vue,
  c'est la sortie d'un `pop` en conflit, d'où `sequencer`.

## Mails et Teams : pourquoi ils ne sont pas là

Demandés en V3, écartés après mesure, pas par manque de temps :

- **Outlook classique en COM est mort sur ce poste.** `HKCU\...\Outlook\Preferences\UseNewOutlook = 1`
  fait que le lancement d'`OUTLOOK.EXE` passe la main au nouveau Outlook puis se termine **sans
  enregistrer sa classe COM** ; l'activation échoue après ~31 s en `CO_E_SERVER_EXEC_FAILURE`.
  Reproduit deux fois, et confirmé par le démarrage d'`olk.exe` à l'instant de la sonde.
- **Microsoft Graph passe par un admin Entra.** Mesuré sur le tenant :
  `defaultUserRolePermissions.allowedToCreateApps = false`, aucune politique de consentement
  utilisateur, et aucun rôle d'annuaire actif pour ce compte. Le claim `scp` du token du CLI Azure
  (`Application.ReadWrite.All`…) est celui de **l'application CLI**, pas les droits de l'utilisateur :
  il fait croire à tort qu'on peut créer une app registration en ligne de commande.
- **La cloche d'activité Teams n'a aucune API de lecture**, même avec Graph. Le maximum lisible serait
  `GET /me/chats` + `viewpoint.lastMessageReadDateTime`, ce qui exclut déjà les mentions en canal.

Si l'app registration arrive un jour : client public, redirect `http://localhost`, délégué
`Mail.Read` + `offline_access` (+ `Chat.Read`), `@azure/msal-node` en device code, jeton chiffré par
le `SecretStore` qui existe déjà, moniteur calqué sur `JiraMonitor`. La place dans
`.projects__header-actions` (l'ancienne `.topbar__actions`, disparue avec la barre de titre) et le
patron de la bande sont laissés prêts.

## Projets configurables

- **Les projets sont de la configuration, pas du code.** `ProjectId` est une string libre, la liste
  vit dans `settings.json`. Ne pas réintroduire de liste en dur : `SEED_FOLDERS` sert uniquement à
  l'amorçage du premier lancement.
- **`kind` et `expectedPort` restent `null` par défaut** pour suivre le `package.json` du dépôt. Les
  remplir de force ferait diverger la config du projet réel.
- **L'id est dérivé du dossier, le libellé est éditable.** Un renommage ne doit jamais changer l'id,
  sinon le terminal en cours devient orphelin.
- **Un projet est un dossier, pas forcément un projet npm.** Seul un chemin vide ou inexistant est une
  `error` de validation ; l'absence de `package.json` ou d'un script visé par une action est un
  `warning`. Ces cas ne cassent qu'un bouton, alors que le statut git, le terminal et `commit`
  fonctionnent. En `error`, une seule ligne de ce type bloquait le bouton « Enregistrer » de tous les
  réglages.
- **Le renderer ne fabrique pas une config de projet.** `buildProjectConfig` (IPC) la construit dans le
  main, donc un projet ajouté depuis le tableau et un projet ajouté depuis les réglages sont
  identiques : même dérivation d'id, même libellé, mêmes actions par défaut. C'était dupliqué aux deux
  endroits, avec déjà deux règles de libellé divergentes.
- **Changer la liste reconstruit le monitor** et ferme les terminaux devenus inatteignables
  (`reconcile`). Le monitor indexe son état par projet, donc le muter en place laisserait des lignes
  fantômes.
- **`expectedPort` ne pilote plus rien** depuis le retrait de la sonde : il ne sert qu'à l'affichage
  dans les réglages. Le port montré par la pastille `sert :4201` vient de la sortie du processus, pas
  de ce réglage. À trancher : le supprimer ou le passer en lecture seule.

## Pièges vérifiés

- **`stripAnsi` doit être ancré sur `\x1b`.** Sans l'ancre, le motif mange `[ERROR]` lui-même.
- **`gh pr checks --watch` bloque.** Utiliser `gh pr view --json statusCheckRollup`.
- **Un rollup vide n'est pas un succès.** Verdict `no-checks` distinct de `passing`.
- **Le pty est un binaire Node-API précompilé** (`@lydell/node-pty`), donc il se charge dans Electron
  sans recompilation. La machine n'a pas la charge C++ de Visual Studio : ne pas introduire de
  dépendance native qui exigerait `node-gyp`.
- **Empaquetage** : les `**/*.node` doivent être en `asarUnpack`. Deux cibles sont produites, NSIS et
  portable, et la portable a besoin de son propre `artifactName` : les deux sortent un `.exe` et se
  disputeraient le même nom de fichier. Elles partagent volontairement l'`appId`, donc le même
  `userData` et le même verrou d'instance unique.
- **L'icône est `resources/icon.ico`**, multi-tailles (16 à 256), générée plutôt que dessinée à la main :
  chaque taille est tracée à sa résolution, avec un trait proportionnellement plus épais en dessous de
  32 px où une réduction transforme le glyphe en bouillie. `windowIcon()` ne la passe aux fenêtres
  **qu'en dev** : un exe empaqueté porte déjà son icône, et le fichier n'est pas dans le bundle.
- **Aucune constante de `DEFAULT_SETTINGS` ne doit venir d'un module qui en importe d'autres.**
  Quand `settings-store` importait `DEFAULT_PROJECTS_ROOT` depuis `registry`, la constante valait
  `undefined` à l'évaluation de `DEFAULT_SETTINGS` : `projectsRoot` partait vide, l'amorçage scannait
  un chemin inexistant, et le dashboard démarrait avec un tableau vide sans la moindre erreur. Ces
  valeurs vivent dans `projects/project-id.ts`, qui n'importe rien.

## Typographie

- **Aucune taille de police en dur dans le CSS.** Les 64 déclarations `font-size` passent par sept
  tokens (`--font-3xs` … `--font-xl`) qui sont des **ratios** de `--ui-font-size`, écrit sur l'élément
  racine depuis `uiFontSize`. Des ratios et pas des tailles absolues, pour une raison mesurable :
  soustraire un pixel fixe d'une base variable aplatit l'échelle quand la base grandit, et une échelle
  typographique paramétrable devient alors sept tailles qui se ressemblent toutes.
- **Les ratios sont les tailles historiques divisées par 12**, le palier du milieu. À la base par défaut
  rien ne bouge d'une fraction de pixel : c'était un refactor, pas une refonte. Ajouter une règle →
  `--font-md`, sauf raison explicite ; les extrêmes existent parce que le design les utilisait déjà
  (en-têtes de colonnes en capitales, badges).
- **Le terminal n'est PAS sur cette échelle.** xterm porte sa taille comme une option, alimentée par
  `terminalFontSize` : deux réglages séparés parce qu'ils répondent à deux questions différentes
  (« est-ce que je lis l'app » contre « combien de sortie tient dans un panneau »). Ne pas les fusionner.
- **`applyUiFontSize` est appelée dans les DEUX renderers.** Le dashboard et la fenêtre de réglages sont
  deux pages du même chrome ; un réglage qui redimensionnerait l'une et pas l'autre se lirait comme un
  bug, celui-ci d'autant plus que le formulaire qui le change est dans la fenêtre qui ne suivrait pas.
  Dans `settings.ts` elle est appelée **avant** les gardes de `onSettingsChanged`, sinon l'écho de sa
  propre sauvegarde — le cas exact qui redimensionne ce formulaire — serait jeté.
- **Changer la taille d'interface refait le `fit` du terminal.** Un texte plus grand rend la rangée
  d'onglets et le chrome de la bande plus hauts, donc la boîte laissée au terminal change de taille sans
  que la fenêtre ait bougé : `resize` ne se déclenche pas. Même piège que l'ouverture du panneau notes.
- **Les bornes (`UI_FONT_SIZE`, 11 à 17) sont plus serrées que celles du terminal**, et c'est délibéré :
  cette taille dessine du texte dans des boîtes dont le padding est fixe, et au-delà une rangée
  d'onglets ou une pastille se serre contre ses propres bordures. Le clamp est doublé côté renderer
  (`clampUiFontSize`) parce qu'un renderer rechargé à chaud peut lire un bootstrap d'un main plus
  ancien, et qu'un `NaN` passé à `setProperty` produit une déclaration invalide : tous les tokens
  retombent alors sur leur valeur de repli, ce qui change toute l'interface sans que rien ne le signale.

## Commandes

```bash
npm run dev        # lance le dashboard depuis les sources
npm test           # Vitest sur les unités pures
npm run lint       # ESLint, zéro warning toléré
npm run typecheck  # tsc sur les projets node, web et test
npm run dist       # installeur dans release/
```

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess`, aucun `any`.
- Code et commentaires **en anglais**. Textes affichés **en français**.
- Les commentaires expliquent le *pourquoi* d'un choix non évident.
- La logique de présentation vit dans `presenters.ts`, pure et testée, séparée du DOM.
