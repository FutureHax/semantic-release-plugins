"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function normalizeConfig(pluginConfig) {
  const { project, channels } = pluginConfig || {};

  if (typeof project !== "string" || !/^[^:/\s]+\/[^:/\s]+$/.test(project)) {
    throw new Error('itch.io plugin requires "project" in "owner/game" format');
  }
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    throw new Error('itch.io plugin requires a "channels" glob map');
  }

  const normalizedChannels = Object.entries(channels).map(([channel, value]) => {
    if (!/^[A-Za-z0-9_-]+$/.test(channel)) {
      throw new Error(`Invalid itch.io channel name: ${channel}`);
    }

    const patterns = (Array.isArray(value) ? value : [value]).filter(
      (pattern) => typeof pattern === "string" && pattern.length > 0,
    );
    if (patterns.length === 0 || patterns.length !== (Array.isArray(value) ? value.length : 1)) {
      throw new Error(`itch.io channel "${channel}" requires a non-empty glob or glob array`);
    }

    return [channel, patterns];
  });

  if (normalizedChannels.length === 0) {
    throw new Error('itch.io plugin requires at least one entry in "channels"');
  }

  return { project, channels: normalizedChannels };
}

function verifyConditions(pluginConfig, context) {
  normalizeConfig(pluginConfig);
  if (!process.env.BUTLER_API_KEY) {
    context.logger.warn("BUTLER_API_KEY not set - itch.io publishing will be skipped");
  }
}

function matchedFiles(patterns, cwd) {
  return [
    ...new Set(
      patterns.flatMap((pattern) => fs.globSync(pattern, { cwd, nodir: true })),
    ),
  ].sort();
}

function stageChannel(files, cwd, channelRoot) {
  const names = new Set();
  for (const file of files) {
    const name = path.basename(file);
    if (names.has(name)) {
      throw new Error(`itch.io channel contains duplicate artifact name: ${name}`);
    }
    names.add(name);
    fs.copyFileSync(path.resolve(cwd, file), path.join(channelRoot, name));
  }
}

async function publish(pluginConfig, context) {
  const { project, channels } = normalizeConfig(pluginConfig);
  const { logger, nextRelease } = context;

  if (!process.env.BUTLER_API_KEY) {
    logger.log("Skipping itch.io publish: BUTLER_API_KEY not set");
    return;
  }

  const cwd = context.cwd || process.cwd();
  const butlerPath = process.env.BUTLER_PATH || "butler";
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-release-itchio-"));

  try {
    for (const [channel, patterns] of channels) {
      const files = matchedFiles(patterns, cwd);
      if (files.length === 0) {
        logger.warn(
          `No artifacts matched itch.io channel "${channel}": ${patterns.join(", ")}`,
        );
        continue;
      }

      const channelRoot = path.join(stagingRoot, channel);
      fs.mkdirSync(channelRoot);
      stageChannel(files, cwd, channelRoot);

      logger.log(
        `Pushing ${files.length} artifact(s) to itch.io: ${project}:${channel} v${nextRelease.version}`,
      );
      const result = childProcess.spawnSync(
        butlerPath,
        ["push", channelRoot, `${project}:${channel}`, "--userversion", nextRelease.version],
        { env: process.env, shell: false, stdio: "inherit" },
      );

      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(
          `Butler failed for ${project}:${channel} with exit code ${result.status}`,
        );
      }
      logger.log(`Pushed itch.io channel ${project}:${channel}`);
    }
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

module.exports = {
  matchedFiles,
  publish,
  verifyConditions,
};
