# Semantic Release Foundry VTT Plugin

A semantic-release plugin for Foundry VTT modules that handles:

- Module ZIP creation from `foundry_vtt/` directory
- Version management in `foundry_vtt/module.json`
- GCS CDN upload with proper cache headers
- Foundry VTT API package listing updates
- Support for both GitHub releases and GCS CDN URLs

## Installation

Add to your project via git URL:

```bash
npm install --save-dev git+https://github.com/FutureHax/github-workflows.git#subdirectory=plugins/foundry-semantic-release
```

Or in `package.json`:

```json
{
  "devDependencies": {
    "@futurehax/semantic-release-foundry-plugin": "git+https://github.com/FutureHax/github-workflows.git#subdirectory=plugins/foundry-semantic-release"
  }
}
```

## Usage

In your `.releaserc.js`:

```javascript
module.exports = {
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    '@semantic-release/npm',
    ['@futurehax/semantic-release-foundry-plugin', {
      githubUrl: process.env.GITHUB_SERVER_URL || 'https://github.com',
      repositoryPath: process.env.GITHUB_REPOSITORY || 'FutureHax/your-module',
      packageId: 'your-foundry-package-id',
      dryRun: false
    }],
    '@semantic-release/github',
    '@semantic-release/git'
  ]
};
```

## Configuration

### Plugin Options

- **`githubUrl`** (string): GitHub server URL (default: from `GITHUB_SERVER_URL` env or `https://github.com`)
- **`repositoryPath`** (string): Repository owner/name (default: from `GITHUB_REPOSITORY` env)
- **`packageId`** (string): Your Foundry VTT package ID (required)
- **`dryRun`** (boolean): Test mode without updating Foundry listing (default: `false`)

### Environment Variables

#### Optional - Foundry VTT API
- **`PACKAGE_RELEASE_TOKEN`**: Foundry VTT package release token (starts with `fvttp_`)
- **`SKIP_FOUNDRY_API`**: Set to `true` to skip the Foundry listing update
- **`FOUNDRY_PROTECTED`**: Set to `true` for Foundry-hosted premium packages. Builds `module-foundry.zip` with `protected: true`, no `download` field, and `manifest` `https://r2.foundryvtt.com/packages-public/{packageId}/module.json`. The JSON release API records that R2 URL; upload `module-foundry.zip` with Foundry's Premium Content Uploader so Foundry can host it.

#### Optional - GCS / CMS
- **`GCS_BUCKET_NAME`**: Google Cloud Storage bucket name
- **`GCS_PRIVATE_BUCKET_NAME`**: Private bucket used when `MANIFEST_BASE_URL` is set
- **`CDN_DOMAIN`**: Custom domain for CDN (default: `downloads.r2plays.games`)
- **`MANIFEST_BASE_URL`**: CMS proxy base (catalog zip keeps `download` URLs)

## Behavior

### Dual artifacts (premium Hub)

When `FOUNDRY_PROTECTED=true` and Foundry API is not skipped:

1. `module.zip` / `module.json` stay the catalog/CMS package (includes `download`).
2. `module-foundry.zip` / `module-foundry.json` are the Hub package (R2 manifest, `protected: true`, no `download`).
3. GCS upload is the catalog zip only.
4. Source `foundry_vtt/module.json` is rewritten to the catalog shape (`protected` false) and is not committed as `protected: true`.

### URL Generation Priority (catalog zip)

1. **If MANIFEST_BASE_URL set**: CMS proxy manifest/download
2. **If GCS_BUCKET_NAME + CDN_DOMAIN set**: `https://downloads.r2plays.games/futurehax/{packageId}/latest/module.json`
3. **If only GCS_BUCKET_NAME**: direct GCS `latest/module.json`
4. **Fallback**: GitHub `releases/latest/download/module.json`

### GCS Upload

When `GCS_BUCKET_NAME` is set, uploads the catalog zip:
- **Versioned**: `gs://{bucket}/futurehax/{packageId}/v{version}/` (1 year cache, immutable)
- **Latest**: `gs://{bucket}/futurehax/{packageId}/latest/` (no-cache)

### Foundry API Update

When `PACKAGE_RELEASE_TOKEN` is set, updates the Foundry VTT package listing. Protected packages send the R2 manifest URL.

## Lifecycle Hooks

- **`prepare`**: Updates catalog `module.json`, creates `module.zip`, and optionally `module-foundry.zip`
- **`publish`**: Uploads catalog artifacts to GCS, updates Foundry API
- **`success`**: Leaves artifacts in place for the reusable workflow

