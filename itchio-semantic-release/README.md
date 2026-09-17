# itch.io Semantic Release Plugin

Publishes release artifacts to itch.io channels with
[Butler](https://itch.io/docs/butler/). Each channel maps to one or more glob
patterns. All matches are staged and pushed together, preserving multiple
installers in a single channel.

## Install

The FutureHax reusable Electron workflow downloads the plugin to
`tasks/semantic-release/itchio-plugin.js` when `use-itchio: true`.

For other workflows, download the standalone CommonJS plugin before running
Semantic Release:

```bash
mkdir -p tasks/semantic-release
curl -sSL \
  https://raw.githubusercontent.com/FutureHax/semantic-release-plugins/main/itchio-semantic-release/index.js \
  -o tasks/semantic-release/itchio-plugin.js
```

## Configure

Add the plugin to the consumer's Semantic Release configuration:

```javascript
[
  './tasks/semantic-release/itchio-plugin.js',
  {
    project: 'futurehax/stream-widgets-relay',
    channels: {
      windows: ['dist/*.exe'],
      macos: ['dist/*.dmg', 'dist/*.zip'],
    },
  },
]
```

`project` must be the itch.io `owner/game` path. Channel values may be one
glob string or an array of globs, resolved relative to the Semantic Release
working directory.

The plugin skips publishing when `BUTLER_API_KEY` is absent. When credentials
are present, Butler failures fail the release; channels with no matching files
emit a warning and are skipped.
