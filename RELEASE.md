# Release

This repo ships two artifacts:

- **NPM package** (`blind-peer-cli`)
- **GHCR Docker image** (`ghcr.io/<owner>/blind-peer-cli`)

Releases are driven by Git tags + GitHub Releases.

## 1) Prepare the version

Bump the package version and tag the release:

```
npm version <major|minor|patch|x.y.z>
```

This updates `package.json`, creates a git commit, and creates a `vX.Y.Z` tag.

## 2) Push the tag

```
git push --follow-tags
```

## 3) Publish the GitHub Release (triggers GHCR)

Create a GitHub Release for the new `vX.Y.Z` tag. When the release is **published**, the GitHub Actions workflow builds and pushes the Docker image to GHCR.

Image tags created:

- `vX.Y.Z`
- `X.Y`
- `latest`

Pull example:

```
docker pull ghcr.io/<owner>/blind-peer-cli:vX.Y.Z
```

## 4) Publish to NPM

```
npm publish --access public
```

(Requires NPM auth with permission to publish `blind-peer-cli`.)

## Notes

- The Docker build uses `package-lock.json`. Make sure it is committed before releasing.
