# FutureHax Semantic Release Plugins

Shared semantic-release plugins for FutureHax projects.

## Available Plugins

### Foundry Semantic Release Plugin

Semantic-release plugin for Foundry VTT modules with GCS CDN support.

**Directory:** `foundry-semantic-release/`  
**Documentation:** [foundry-semantic-release/README.md](./foundry-semantic-release/README.md)

**Installation:**

```bash
# In your Foundry module project
npm install --save-dev git+https://github.com/FutureHax/semantic-release-plugins.git#subdirectory=foundry-semantic-release
```

Or reference directly in `.releaserc.js` using URL:

```javascript
// The workflow auto-downloads this, so no npm install needed
['./tasks/semantic-release/foundry-module-plugin.js', {
  githubUrl: process.env.GITHUB_SERVER_URL || 'https://github.com',
  repositoryPath: process.env.GITHUB_REPOSITORY || 'FutureHax/your-module',
  packageId: 'your-package-id',
  dryRun: false
}]
```

## Usage in Workflows

For Foundry VTT modules using the `foundry-module-semantic-release.yml` workflow, the plugin is automatically downloaded at build time.

## Contributing

To update a plugin:

1. Make changes in this repository
2. Test in a module project
3. Commit and push
4. All projects using the workflow will automatically get the update on their next release

## License

MIT

