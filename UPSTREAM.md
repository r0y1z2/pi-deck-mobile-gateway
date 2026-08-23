# Upstream Attribution

This repository is an unofficial downstream snapshot of the Pi monorepo from
[earendil-works/pi](https://github.com/earendil-works/pi).

The source snapshot identifies the server package as version `0.83.0`. The
source bundle used to prepare this repository did not contain Git metadata, so
an exact upstream commit cannot be stated reliably. No commit hash is inferred.

The downstream Pi Deck Mobile Gateway work is concentrated in:

- `packages/server/src/deck.ts`
- `packages/server/src/deck/`
- `packages/server/src/cli.ts`
- `packages/server/test/deck.test.ts`
- `packages/server/README.md`
- `scripts/pideck-mobile/`

The remaining packages are retained because the server is built from Pi's npm
workspace dependency graph. The original project overview and security policy
are preserved as [UPSTREAM_README.md](UPSTREAM_README.md) and
[UPSTREAM_SECURITY.md](UPSTREAM_SECURITY.md).

Pi and this downstream snapshot are distributed under the MIT License. The
original copyright and license text are retained in [LICENSE](LICENSE).

This project is not an official PiDeck release and is not endorsed by the Pi or
PiDeck maintainers.
