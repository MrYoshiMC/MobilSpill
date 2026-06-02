# Phone Tennis

A browser party sports game where phones connect as motion controllers.

## Upload to GitHub Pages

1. Create a new GitHub repository.
2. Upload everything in this folder to the repository root.
3. In GitHub, open Settings > Pages.
4. Set Source to "Deploy from a branch".
5. Pick the `main` branch and `/root`, then save.
6. Open the Pages URL on a computer for the TV screen.
7. Use the shown phone link or enter the game code on a phone.

Phone motion controls work best on HTTPS, so the GitHub Pages URL is preferred over a plain local file.

If WebRTC is blocked on a network, the game falls back to an MQTT-over-WebSocket relay so phone inputs can still reach the PC.
