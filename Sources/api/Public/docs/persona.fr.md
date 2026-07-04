# Personas

Imaginez comment votre entreprise fonctionne. Sarah l'ingénieure, Marcus le designer, Priya la chef de produit—chaque personne apporte sa propre expertise, ses opinions et ses limites. Sarah n'approuve pas les budgets. Marcus n'architecte pas les systèmes. Priya ne choisit pas les couleurs des boutons.

**Les personas sont comment vous encodez de vraies personnes dans OpenLoop.**

## Qu'est-ce qui fait un bon persona ?

Un persona est un agent IA avec un rôle, une personnalité et une tâche spécifiques. La clé est de les rendre *opinionés*. Un "reviewer de code" générique donne des retours génériques. Mais un persona modélisé d'après votre véritable ingénieur—qui déteste la sur-ingénierie et se battra contre l'optimisation prématurée—ce persona donne des retours utiles.

## Les quatre parties d'un persona

- **Nom** — Comment vous l'appelez (ex., "Sarah-la-Rigoureuse")
- **Rôle** — Son expertise (ex., "Ingénieure Logicielle Senior, 10 ans d'expérience")
- **À propos** — Personnalité, contexte, comment elle aborde le travail
- **Tâche** — Ce qu'elle doit faire quand activée

## Exemple réel

Disons que vous avez une ingénieure senior nommée Sarah. Dans la vraie vie, Sarah :
- Revoy chaque PR au peigne fin
- Déteste le code "intelligent" et préfère les solutions ennuyeuses et évidentes
- A des opinions fortes sur l'organisation du code

Voici comment vous encodez Sarah comme persona :

**Nom :** Sarah-la-Rigoureuse
**Rôle :** Ingénieure Logicielle Senior
**À propos :** 10 ans d'expérience. Croit que le code ennuyeux est du bon code. Opinions fortes sur la séparation des préoccupations et le nommage. Déteste l'abstraction prématurée.
**Tâche :** Reviewer les changements de code frontend fournis. Être minutieux. Vérifier l'organisation du code et la sur-ingénierie. Être opinioné—ne dites pas simplement "ça a l'air bon" à moins que ce ne soit vraiment le cas.

Quand ce persona s'exécute dans un workflow, il apporte la perspective de Sarah. Pas de réponses génériques "En tant que modèle de langage AI, je pense...". Il répond comme Sarah le ferait.

## Rédiger des tâches efficaces

Une tâche bien rédigée suit une formule simple :

1. **Commencer par un verbe** — `Créer`, `Implémenter`, `Reviewer`, `Analyser`, `Refactoriser`, `Déboguer`
2. **Définir le périmètre** — Que faire et comment l'aborder (2-3 phrases maximum)
3. **Délimiter les frontières** — Si en dehors de votre expertise, le reconnaître et s'arrêter

**Bonne tâche :**
> Reviewer les changements de code frontend. Vérifier les conventions de nommage et la sur-ingénierie. Si cela implique une logique métier hors de votre expertise (ex. calculs financiers), le dire et limiter les retours à la qualité du code uniquement.

**Mauvaise tâche :**
> Aider avec le code. (Trop vague, pas d'action claire, pas de limites)

## Pourquoi les personas opinionés comptent

Les agents IA génériques donnent des réponses génériques. Les personas opinionés donnent des réponses *utiles*.

Un persona designer ne devrait pas suggérer de changements d'architecture. Un persona CTO ne devrait pas commenter les couleurs des boutons. Chaque persona possède son domaine. C'est ainsi que vous obtenez une IA qui fonctionne vraiment comme votre équipe.

## Les personas ont un territoire

Ce n'est pas juste une question de "meilleure sortie"—c'est une question de **collaboration réaliste**.

Quand vous créez des personas, vous ne faites pas qu'écrire des prompts. Vous encodez l'expertise du persona dans son dossier, en plaçant ses fichiers de "connaissance". Habituellement ce sont des fichiers markdown que l'agent LLM peut lire, comprendre et utiliser.

## Le bac à sable : expérimenter avec les structures organisationnelles

Voici la partie amusante. Vous n'êtes pas coincé avec la façon dont votre entreprise fonctionne—vous pouvez modéliser comment vous *souhaitez* qu'elle fonctionne :

> Que se passe-t-il quand vous :
> - Ajoutez un reviewer sécurité à chaque workflow de fonctionnalité ?
> - Faites la revue design *avant* le développement au lieu d'après ?
> - Supprimez un goulot d'étranglement—qu'est-ce qui casse quand le CTO ne signe pas ?
> - Découvrez qu'il vous manque un rôle—peut-être avez-vous besoin d'un rédacteur technique ?

Vos personas répondront authentiquement parce qu'ils ont de vraies opinions et territoires. La simulation vous apprend quelque chose sur le processus—sans le coût réel de réorganiser votre véritable équipe.

## Comment les personas s'articulent

- **[Workflows](workflow)** intègrent les personas dans des niveaux structurés qui s'exécutent comme un processus "waterfall" - pas "agile"
- **[Instances](instance)** sont l'entreprise où tous vos personas vivent et travaillent

Pensez aux personas comme à vos membres d'équipe. Les workflows sont les processus qu'ils suivent.

## Personas et Agents LLM

OpenLoop lance chaque persona comme son propre agent LLM (OpenCol, Claude Code, Mistral Vibe, ...). C'est ainsi que vous pouvez utiliser plusieurs agents LLM simultanément pour travailler ensemble sur la même tâche.
Vous pouvez assigner un agent individuel à chaque persona.

## MCPs

Quand OpenLoop lance un agent LLM pour un persona particulier, vous pouvez personnaliser la liste des serveurs MCP à utiliser, ou utiliser l'ensemble par défaut.

L'exemple ci-dessous utilise le nom de fichier `mcp-yolo.json` qui est lié à l'agent Claude Code. D'autres agents peuvent utiliser d'autres noms de fichiers, donc tenez compte d'un nom de fichier différent dans l'exemple ci-dessous.

Le fichier de configuration MCP par défaut se trouve dans `<dossier-projet>/.openloop/mcp-yolo.json`. Par défaut il est vide, vous pouvez ajouter vos MCPs spécifiques au projet.
Si vous voulez qu'un <persona> utilise un ensemble spécifique de MCPs, vous pouvez créer `<dossier-projet>/.openloop/knowledge/<persona-id>-mcp-yolo.json` et le configurer comme souhaité.

OpenLoop cherchera d'abord le fichier MCP personnalisé du persona, puis le fichier à l'échelle du projet.

Par exemple, voir `scripts/yolo/openloop_cc_docker` dans le code source d'OpenLoop ou `~/.local/bin/openloop_cc_docker` si vous avez déjà installé OpenLoop.
