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
- **Cliquer une ligne ouvre le shell du dépôt, et le réutilise.** Le geste est trop facile à
  déclencher pour empiler un onglet par clic. Un shell de dépôt porte donc un `projectId` **et** pas
  d'`actionId` : tout code qui parcourt ces deux champs doit accepter ce couple. La règle de
  fermeture vit dans `isUnreachable`, pure et testée, précisément parce que ce cas s'y trompe.
- **Un clic sur un contrôle ne doit pas atteindre la ligne** (`closest('button, input, …')`). Sans ça,
  un clic sur une action la lance *et* ouvre un shell, et le double-clic de renommage ouvre un
  terminal qui vole le focus au champ qui vient d'apparaître.
- **Ne jamais détacher un terminal xterm du DOM.** `open()` sort tôt quand le terminal a déjà un
  élément : le détacher le laisse vivant mais invisible pour toujours. Un conteneur permanent par
  session, on bascule `hidden`. C'est aussi pourquoi la surface est une **grille** et que l'ordre des
  panneaux se fait avec la propriété CSS `order` : réordonner en déplaçant les nœuds tuerait les xterm.
- **La disposition des panneaux est à une seule direction** (`columns` ou `rows`), pas un arbre
  imbriqué. Choix assumé face à Windows Terminal : la position d'un panneau se déduit de son index, ce
  qui rend l'arithmétique pure et testable (`insertPane`, `removePane`, `replacePane`). Ne pas
  introduire de mélange des directions sans passer à un vrai arbre.
- **Elle vit dans le main**, comme l'ordre des onglets et pour la même raison. Le renderer calcule la
  liste entière et l'envoie ; le main valide (ids inconnus retirés, doublons écrasés, jamais vide) et
  la rediffuse. Un `syncLayout` la recale quand une session naît ou meurt, sinon un panneau serait un
  trou.
- **Cliquer un onglet non visible remplace le panneau focalisé**, il ne réduit pas la vue à un seul
  panneau : parcourir les onglets ne doit pas détruire une disposition. Une seule règle, valable aussi
  pour une action fraîchement lancée. Un split, lui, **ajoute** un panneau : il ne passe donc pas par
  `focusTerminal`.
- **Fermer un panneau ne tue pas son terminal.** La vue et la vie d'un terminal sont deux choses
  distinctes ; un clic dans un menu contextuel ne doit pas pouvoir arrêter un serveur de dev.
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
- **L'ordre des onglets vit dans le main**, dans l'ordre d'insertion de la `Map` des sessions
  (`reorder` la reconstruit). Le garder dans le renderer le perdrait à chaque rechargement à chaud, et
  c'est `bootstrap` qu'un renderer neuf lit. Les ids inconnus de l'appelant sont ajoutés à la fin, pas
  écartés : un onglet peut naître entre le début du glisser et le lâcher.
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
- **`settings:update` diffuse, sauf pour `projectsHeight` seul.** Cette clé naît dans le dashboard et
  s'écrit à chaque relâchement du séparateur ; la renvoyer ferait reconstruire le tableau et le terminal
  à chaque redimensionnement. Tout le reste peut venir de la fenêtre de réglages et doit arriver.
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

- **La bande du haut a deux onglets, le terminal n'en dépend pas.** Seul le contenu de la bande change ;
  un onglet qui volerait la place du terminal irait contre tout le reste de cette app.
- **Chaque onglet a sa hauteur** (`projectsHeight`, `pullsHeight`) : un tableau de quatre lignes et une
  liste maître-détail n'ont pas les mêmes besoins. `attachPaneResizer` renvoie un `setHeight` pour que le
  changement d'onglet applique la bonne, sans dupliquer le bornage ailleurs.
- **Un `display` posé par une classe écrase le `[hidden]` du navigateur.** `.pulls` est en `display: grid`,
  donc il a fallu un `.pulls[hidden] { display: none }` explicite : sans lui les deux vues s'empilaient à
  l'écran. Même piège que `.terminal__view`.
- **Les dépôts sont déduits des projets** via `git remote get-url origin` (`readRemoteSlug`), avec une case
  `followPulls` par projet. Pas de seconde liste à tenir à jour ; corollaire assumé, un dépôt non cloné ne
  peut pas être suivi.
- **Un seul appel `gh pr list` par dépôt**, filtrage « les miennes » en local sur les `login`. Filtrer côté
  GitHub aurait coûté deux appels par dépôt, sa syntaxe de recherche ne sachant pas faire ce `OR`. La
  charge utile complète est donc en main : élargir le filtre plus tard ne coûtera aucun appel.
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
- **Les écritures rafraîchissent tout de suite** (`afterJiraWrite`) : la ligne qu'on vient de changer doit
  montrer son nouvel état sans attendre le tour de boucle de cinq minutes.
- **Les lignes de tickets sont une grille**, pas une ligne flex : leurs badges sont conditionnels, donc en
  flex aucune ligne n'était d'accord sur l'emplacement du statut. L'assigné vient avant le statut, et la
  colonne disparaît dans « Mes tickets » où chaque ligne porterait le même nom.
- **`context-menu.ts` n'a aucun effet de bord à l'import.** Ses écouteurs de fermeture sont posés à la
  première ouverture : au chargement du module, deux fichiers de tests sans DOM cassaient.
- **Pas de placeholder d'exemple dans les réglages.** Un exemple grisé se lit comme une valeur déjà
  enregistrée ; là où un placeholder subsiste, c'est une valeur déduite, et il est en italique très pâle.

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
