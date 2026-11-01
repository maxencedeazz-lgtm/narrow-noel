[LISEZMOI.md](https://github.com/user-attachments/files/34247908/LISEZMOI.md)
# Narrow Noël – le site

Capture du drapeau à l’arc, en multijoueur avec tes potes, sur le Village de Noël et la Gorge Gelée.

Le dossier contient tout le site :
- `index.html` : le jeu (maps comprises) ;
- `server.js` : le serveur qui envoie la page et relie les joueurs en temps réel (aucune dépendance à installer) ;
- `package.json` : dit à l’hébergeur comment le lancer (`npm start`).

## Le mettre en ligne gratuitement (Render)

1. Crée un compte sur https://github.com puis un nouveau dépôt (bouton « New », nom : `narrow-noel`, public).
2. Dans le dépôt : « Add file » puis « Upload files », glisse tous les fichiers du dossier (`index.html`, `server.js`, `package.json`, `manifest.webmanifest`, `sw.js` et les trois images `icon-…png`), puis « Commit changes ».
3. Crée un compte sur https://render.com (connexion avec GitHub, c’est le plus simple).
4. « New » puis « Web Service », et choisis ton dépôt `narrow-noel`.
5. Réglages : Runtime Node, Build Command `npm install`, Start Command `node server.js`, offre Free. Clique sur « Deploy ».
6. Au bout d’une à deux minutes, Render affiche ton lien, du genre `https://narrow-noel.onrender.com`. C’est ce lien que tu donnes à tes potes.

Sur l’offre gratuite, le site s’endort après 15 minutes sans joueur. La première personne qui l’ouvre attend alors environ une minute, ensuite tout est rapide.

## Installer le jeu comme une appli

Sur ton site, le jeu peut s'installer comme une vraie application : une icône sur le bureau (ta pièce !), le jeu dans sa propre fenêtre, sans barre d'adresse.

- Sur Chrome ou Edge (PC) : clique sur le bouton « Installer le jeu » en haut du menu, ou sur l'icône d'installation à droite de la barre d'adresse.
- Sur Android : menu ⋮ puis « Ajouter à l'écran d'accueil ».
- Sur iPhone (Safari) : bouton Partager puis « Sur l'écran d'accueil ».

Une fois installé, le mode solo marche même sans Internet. Le multijoueur et la sauvegarde des comptes passent par ton serveur, donc il faut être connecté. Les mises à jour arrivent toutes seules au prochain lancement.

## Comptes (pseudo + mot de passe)

Sur le menu, la carte « Compte » permet de créer un compte. Les pièces, les stats et les achats de la boutique sont alors sauvegardés sur le serveur : on les retrouve sur n’importe quel ordi en se connectant. Les mots de passe sont chiffrés (scrypt), jamais stockés en clair, et le serveur bloque les essais en boucle.

Par défaut, les comptes sont enregistrés dans un fichier `data/accounts.json` à côté de `server.js`. C’est parfait sur ton ordi, mais sur l’offre gratuite de Render le disque est effacé à chaque redémarrage du site : les comptes seraient perdus. Pour les garder pour de bon, branche une base Upstash (gratuite) :

1. Crée un compte sur https://upstash.com puis « Create Database » (type Redis, région Europe, offre Free).
2. Dans la page de la base, section « REST API », copie `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`.
3. Sur Render, ouvre ton service, onglet « Environment », ajoute ces deux variables avec leurs valeurs, puis « Save Changes » (le site redémarre tout seul).
4. Au démarrage, les logs de Render doivent afficher « comptes : Upstash Redis ».

Option : ajoute aussi une variable `SESSION_SECRET` (une longue suite de caractères au hasard) pour signer les sessions.

## Jouer

- Tout le monde ouvre le lien et met son pseudo.
- Une personne clique sur « Créer une partie », puis sur « Copier le lien d’invitation » dans la salle d’attente, et l’envoie au groupe. Le lien remplit le code tout seul.
- Les autres cliquent sur « Rejoindre », ou sur la partie dans la liste des parties ouvertes.
- L’hôte lance la partie. Les bots complètent les équipes jusqu’à 5 si l’option est activée.

## Tester sur ton ordi

Avec Node.js installé (https://nodejs.org), ouvre un terminal dans ce dossier, tape `node server.js`, puis va sur http://localhost:3000.
Tes potes connectés au même wifi peuvent venir sur `http://ADRESSE-IP-DE-TON-ORDI:3000`.
