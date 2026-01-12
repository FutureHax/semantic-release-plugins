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

#### Required
- **`GITHUB_REPOSITORY`**: Auto-set by GitHub Actions

#### Optional - Foundry VTT API
- **`PACKAGE_RELEASE_TOKEN`**: Foundry VTT package release token (starts with `fvttp_`)
  - If not set, skips Foundry API update but still creates release

#### Optional - GCS CDN
- **`GCS_BUCKET_NAME`**: Google Cloud Storage bucket name
- **`CDN_DOMAIN`**: Custom domain for CDN (default: `download.r2plays.games`)
  - If `GCS_BUCKET_NAME` is set, uploads to: `gs://{bucket}/futurehax/{packageId}/v{version}/`
  - Files accessible at: `https://{domain}/futurehax/{packageId}/v{version}/`

## Behavior

### URL Generation Priority

1. **If GCS_BUCKET_NAME + CDN_DOMAIN set**: Uses `https://download.r2plays.games/futurehax/{packageId}/v{version}/`
2. **If only GCS_BUCKET_NAME**: Uses `https://storage.googleapis.com/{bucket}/futurehax/{packageId}/v{version}/`
3. **Fallback**: Uses `https://github.com/{owner}/{repo}/releases/download/v{version}/`

### GCS Upload

When `GCS_BUCKET_NAME` is set, uploads:
- **Versioned**: `gs://{bucket}/futurehax/{packageId}/v{version}/` (1 year cache, immutable)
- **Latest**: `gs://{bucket}/futurehax/{packageId}/latest/` (no-cache)

### Foundry API Update

When `PACKAGE_RELEASE_TOKEN` is set, updates the Foundry VTT package listing with the manifest URL.

## Workflow Integration

Works with the `foundry-module-semantic-release.yml` workflow from this repository.

See [alpha-5-module](https://github.com/FutureHax/alpha-5-module) for a complete example.

## Lifecycle Hooks

- **`prepare`**: Updates `module.json`, creates `module.zip`
- **`publish`**: Uploads to GCS CDN (if configured), updates Foundry API (if token set)
- **`success`**: Cleans up temporary files (`module.json`, `module.zip`)

