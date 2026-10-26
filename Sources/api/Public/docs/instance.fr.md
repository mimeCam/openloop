# Instances

## Qu'est-ce qu'une instance ?

Une Instance est un exécuteur OpenLoop autonome qui vit sur votre machine. C'est un travailleur en arrière-plan qui exécute vos workflows selon un calendrier.

Vous la configurez une fois. Elle continue de travailler. Pour toujours.
Vous observez ensuite les résultats et ajustez les prompts pour mieux répondre à vos besoins.

## Comment ça fonctionne

Chaque instance surveille un dossier contenant vos personas et workflows. Quand le calendrier d'un workflow se déclenche—l'instance se réveille et exécute ce workflow.

Les [Workflows](workflow) représentent les processus dans une entreprise.
Les [Personas](persona) représentent les employés opinionnés effectuant chacun leur rôle.

Réfléchissez à la façon dont votre entreprise fonctionne et encodez-la dans un ensemble de workflows structurés.

Une instance est votre simulation toujours active. Configurez-la, lancez des expériences, itérez, et laissez le workflow vous apprendre ce qui fonctionne. Allez faire autre chose pendant que votre bac à sable organisationnel se gère lui-même.

## La magie de la surveillance de dossier

Les instances sont liées à des dossiers. Cela signifie :
- Différents projets peuvent avoir différentes instances
- Chaque instance peut définir son propre ensemble de [personas](persona) et de [workflows](workflow)
- Vous pouvez lancer une instance pour un projet spécifique et l'arrêter quand c'est fini

## La hiérarchie des dossiers

Les dossiers de projets s'imbriquent, et une instance lit dans toute l'échelle : son propre `.openloop` d'abord, puis celui de chaque projet parent jusqu'à votre dossier personnel, et le partage global — `~/.local/share/openloop` — en dernier. Les recherches vont toujours au plus proche : la définition la plus proche gagne.

Ce qui se résout à travers l'échelle :
- Les [personas](persona), [workflows](workflow) et connaissances de persona — définis une fois en haut, réutilisés dans chaque projet en dessous.
- Les fonctionnalités de nœuds (serveurs MCP sur les nœuds du graphe) voyagent attachées aux personas — voir [Personas](persona) pour le flux de partage approuvé.

Ce qui ne voyage jamais : l'état d'exécution. Les journaux et artefacts d'exécution atterrissent toujours dans le `.openloop` du projet en cours — les projets parents et le partage global sont des entrées en lecture seule, jamais écrites.
