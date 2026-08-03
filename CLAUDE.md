# oxum-dev-dashboard — instructions projet

Dashboard Electron sur l'état des 3 fronts (serveurs de dev, git, checks GitHub) et des sessions
Claude Code locales, avec terminal embarqué.

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
- **Sonder `localhost`, jamais `127.0.0.1`.** Les serveurs Angular n'écoutent qu'en IPv6.
- **`taskkill /T /F` pour arrêter**, pas `pty.kill()` : ce dernier ne touche que le `cmd.exe`
  d'enveloppe et laisse `ng serve` tenir le port.
- **Les serveurs externes restent visibles** (état `external`, sans boutons de contrôle). Un
  dashboard qui affiche « arrêté » alors qu'un serveur tourne est pire qu'un dashboard vide.
- **Confirmation avant de quitter** quand des processus possédés tournent : ils meurent avec l'app.
- **Sessions Claude : métadonnées uniquement** (`type`, `timestamp`, `cwd`, `gitBranch`). Ne jamais
  charger ni afficher le contenu des messages.
- **Ne pas modifier `~/.claude/settings.json`.** C'est la configuration globale de Julio. Le hook
  optionnel se documente, il ne s'installe pas.
- **Le renderer reste sandboxé** : pas de `fs`, pas de `child_process`, CSP verrouillée, DOM construit
  avec `textContent` (branches, erreurs et titres de PR viennent de l'extérieur).

## Pièges vérifiés

- **PowerShell 5.1 emballe les tableaux** : `ConvertTo-Json` produit `{"value":[...],"Count":n}`.
  Le parseur doit accepter tableau nu, objet seul et enveloppe.
- **`stripAnsi` doit être ancré sur `\x1b`.** Sans l'ancre, le motif mange `[ERROR]` lui-même.
- **`gh pr checks --watch` bloque.** Utiliser `gh pr view --json statusCheckRollup`.
- **Un rollup vide n'est pas un succès.** Verdict `no-checks` distinct de `passing`.
- **Le pty est un binaire Node-API précompilé** (`@lydell/node-pty`), donc il se charge dans Electron
  sans recompilation. La machine n'a pas la charge C++ de Visual Studio : ne pas introduire de
  dépendance native qui exigerait `node-gyp`.
- **Empaquetage** : les `**/*.node` doivent être en `asarUnpack`.

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
