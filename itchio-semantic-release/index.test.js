"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, describe, it, mock } = require("node:test");

const plugin = require("./index.js");

const originalApiKey = process.env.BUTLER_API_KEY;

afterEach(() => {
  mock.restoreAll();
  if (originalApiKey === undefined) {
    delete process.env.BUTLER_API_KEY;
  } else {
    process.env.BUTLER_API_KEY = originalApiKey;
  }
});

function logger() {
  return {
    log: mock.fn(),
    warn: mock.fn(),
  };
}

describe("verifyConditions", () => {
  it("requires a project", () => {
    assert.throws(
      () => plugin.verifyConditions({ channels: { windows: "dist/*.exe" } }, { logger: logger() }),
      /requires "project"/,
    );
  });

  it("validates channel glob mappings", () => {
    assert.throws(
      () =>
        plugin.verifyConditions(
          { project: "futurehax/relay", channels: { windows: [] } },
          { logger: logger() },
        ),
      /non-empty glob/,
    );
  });
});

describe("publish", () => {
  it("stages all channel matches and pushes them once", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "itchio-plugin-test-"));
    fs.mkdirSync(path.join(cwd, "dist"));
    fs.writeFileSync(path.join(cwd, "dist", "relay-setup.exe"), "setup");
    fs.writeFileSync(path.join(cwd, "dist", "relay-portable.exe"), "portable");
    fs.writeFileSync(path.join(cwd, "dist", "relay.dmg"), "dmg");
    fs.writeFileSync(path.join(cwd, "dist", "relay-mac.zip"), "zip");
    process.env.BUTLER_API_KEY = "test-only";

    const calls = [];
    mock.method(childProcess, "spawnSync", (command, args, options) => {
      calls.push({ command, args, options, files: fs.readdirSync(args[1]).sort() });
      return { status: 0 };
    });

    await plugin.publish(
      {
        project: "futurehax/relay",
        channels: {
          windows: ["dist/*.exe"],
          macos: ["dist/*.dmg", "dist/*.zip"],
        },
      },
      { cwd, logger: logger(), nextRelease: { version: "1.2.3" } },
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, "butler");
    assert.deepEqual(calls[0].args.slice(0, 1), ["push"]);
    assert.deepEqual(calls[0].args.slice(2), [
      "futurehax/relay:windows",
      "--userversion",
      "1.2.3",
    ]);
    assert.deepEqual(calls[0].files, ["relay-portable.exe", "relay-setup.exe"]);
    assert.equal(calls[0].options.shell, false);
    assert.deepEqual(calls[1].args.slice(2), [
      "futurehax/relay:macos",
      "--userversion",
      "1.2.3",
    ]);
    assert.deepEqual(calls[1].files, ["relay-mac.zip", "relay.dmg"]);

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("skips publishing without BUTLER_API_KEY", async () => {
    delete process.env.BUTLER_API_KEY;
    const spawn = mock.method(childProcess, "spawnSync");
    const log = logger();

    await plugin.publish(
      { project: "futurehax/relay", channels: { macos: "dist/*.{dmg,zip}" } },
      { logger: log, nextRelease: { version: "1.2.3" } },
    );

    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(log.log.mock.callCount(), 1);
  });
});
