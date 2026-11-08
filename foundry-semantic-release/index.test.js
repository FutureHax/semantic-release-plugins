"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { STATUS_FILE, publishFoundryRelease } = require("./index.js");
const FOUNDRY_RELEASE_API_URL = "https://api.foundryvtt.com/_api/packages/release_version/";
const plugin = require("./index.js");

const payload = { id: "oh-you-dead", "dry-run": false, release: { version: "1.6.0", manifest: "m", notes: "n" } };
const silent = { log() {}, warn() {}, error() {} };
const noSleep = async () => {};

function respond(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function fetchSequence(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

const alreadyExists = {
  status: "error",
  errors: {
    __all__: [
      { message: "Package Version with this Package and Version Number already exists.", code: "unique_together" },
    ],
  },
};

describe("publishFoundryRelease", () => {
  it("publishes on 2xx success", async () => {
    const { fetchImpl, calls } = fetchSequence(
      respond(200, { status: "success", page: "https://foundryvtt.com/packages/x/edit/" }),
    );
    const result = await publishFoundryRelease({
      token: "fvttp_x",
      payload,
      fetchImpl,
      logger: silent,
      sleep: noSleep,
    });
    assert.equal(result.outcome, "published");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, FOUNDRY_RELEASE_API_URL);
    assert.equal(calls[0].init.headers.Authorization, "fvttp_x");
    assert.deepEqual(JSON.parse(calls[0].init.body), payload);
  });

  it("reports a dry run when dry-run is set", async () => {
    const { fetchImpl } = fetchSequence(
      respond(200, { status: "success", message: "Dry run completed successfully." }),
    );
    const result = await publishFoundryRelease({
      token: "fvttp_x",
      payload: { ...payload, "dry-run": true },
      fetchImpl,
      logger: silent,
      sleep: noSleep,
    });
    assert.equal(result.outcome, "dry-run");
  });

  it("treats Foundry's unique_together rejection as already published", async () => {
    const { fetchImpl, calls } = fetchSequence(respond(400, alreadyExists));
    const result = await publishFoundryRelease({
      token: "fvttp_x",
      payload,
      fetchImpl,
      logger: silent,
      sleep: noSleep,
    });
    assert.equal(result.outcome, "already-exists");
    assert.equal(calls.length, 1);
  });

  it("fails on a non-2xx HTTP error", async () => {
    const { fetchImpl, calls } = fetchSequence(respond(403, { status: "error", message: "Invalid token" }));
    await assert.rejects(
      publishFoundryRelease({ token: "fvttp_x", payload, fetchImpl, logger: silent, sleep: noSleep }),
      (error) => error.code === "EFOUNDRYAPI" && /HTTP 403/.test(error.message) && /Invalid token/.test(error.message),
    );
    assert.equal(calls.length, 1);
  });

  it("fails on a non-JSON error body", async () => {
    const { fetchImpl } = fetchSequence(respond(400, "<html>Bad Request</html>"));
    await assert.rejects(
      publishFoundryRelease({ token: "fvttp_x", payload, fetchImpl, logger: silent, sleep: noSleep }),
      /HTTP 400 <html>Bad Request<\/html>/,
    );
  });

  it("fails on a 2xx response whose JSON body reports an error", async () => {
    const { fetchImpl } = fetchSequence(
      respond(200, { status: "error", errors: { manifest: ["Enter a valid URL."] } }),
    );
    await assert.rejects(
      publishFoundryRelease({ token: "fvttp_x", payload, fetchImpl, logger: silent, sleep: noSleep }),
      (error) => error.code === "EFOUNDRYAPI" && /Enter a valid URL/.test(error.message),
    );
  });

  it("fails before any request when the token is missing or blank", async () => {
    for (const token of [undefined, "", "   "]) {
      const { fetchImpl, calls } = fetchSequence();
      await assert.rejects(
        publishFoundryRelease({ token, payload, fetchImpl, logger: silent, sleep: noSleep }),
        (error) => error.code === "ENOFOUNDRYTOKEN",
      );
      assert.equal(calls.length, 0);
    }
  });

  it("waits out a 429 once using Retry-After, then succeeds", async () => {
    const waits = [];
    const { fetchImpl, calls } = fetchSequence(
      respond(429, { status: "error", message: "rate limited" }, { "Retry-After": "42" }),
      respond(200, { status: "success" }),
    );
    const result = await publishFoundryRelease({
      token: "fvttp_x",
      payload,
      fetchImpl,
      logger: silent,
      sleep: async (ms) => waits.push(ms),
    });
    assert.equal(result.outcome, "published");
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [43_000]);
  });

  it("fails when a 429 persists after the single retry", async () => {
    const { fetchImpl, calls } = fetchSequence(respond(429, {}, { "Retry-After": "60" }), respond(429, {}));
    await assert.rejects(
      publishFoundryRelease({ token: "fvttp_x", payload, fetchImpl, logger: silent, sleep: noSleep }),
      /HTTP 429/,
    );
    assert.equal(calls.length, 2);
  });

  it("counts already-exists on the retry as success (first attempt landed)", async () => {
    const { fetchImpl } = fetchSequence(new Error("socket hang up"), respond(400, alreadyExists));
    const result = await publishFoundryRelease({
      token: "fvttp_x",
      payload,
      fetchImpl,
      logger: silent,
      sleep: noSleep,
    });
    assert.equal(result.outcome, "already-exists");
  });

  it("fails when the request throws twice", async () => {
    const { fetchImpl } = fetchSequence(new Error("ECONNRESET"), new Error("ECONNRESET"));
    await assert.rejects(
      publishFoundryRelease({ token: "fvttp_x", payload, fetchImpl, logger: silent, sleep: noSleep }),
      (error) => error.code === "EFOUNDRYREQUEST" && /ECONNRESET/.test(error.message),
    );
  });
});

describe("foundry-semantic-release Foundry lifecycle", () => {
  const ENV_KEYS = [
    "SKIP_FOUNDRY_API",
    "PACKAGE_RELEASE_TOKEN",
    "GCS_BUCKET_NAME",
    "CDN_DOMAIN",
    "FOUNDRY_PROTECTED",
    "GITHUB_ACTIONS",
  ];
  let savedEnv;
  let savedCwd;
  let savedFetch;
  let dir;
  let calls;

  const context = (extra = {}) => ({ nextRelease: { version: "1.6.0" }, logger: silent, options: {}, ...extra });
  const status = () => JSON.parse(fs.readFileSync(path.join(dir, STATUS_FILE), "utf8"));
  const stubFetch = (...responses) => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    };
  };

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    savedCwd = process.cwd();
    savedFetch = globalThis.fetch;
    calls = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-plugin-"));
    fs.mkdirSync(path.join(dir, "foundry_vtt"));
    fs.writeFileSync(
      path.join(dir, "foundry_vtt", "module.json"),
      JSON.stringify({ id: "oh-you-dead", compatibility: { minimum: "13", verified: "13" } }),
    );
    process.chdir(dir);
    process.env.GCS_BUCKET_NAME = "artifacts";
    process.env.CDN_DOMAIN = "downloads.r2plays.games";
  });

  afterEach(() => {
    process.chdir(savedCwd);
    globalThis.fetch = savedFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("verifyConditions fails fast when publishing is enabled without a token", async () => {
    await assert.rejects(plugin.verifyConditions({}, context()), (error) => error.code === "ENOFOUNDRYTOKEN");
    process.env.PACKAGE_RELEASE_TOKEN = "   ";
    await assert.rejects(plugin.verifyConditions({}, context()), (error) => error.code === "ENOFOUNDRYTOKEN");
    process.env.PACKAGE_RELEASE_TOKEN = "fvttp_x";
    await plugin.verifyConditions({}, context());
  });

  it("skip=true makes no API call and never fails", async () => {
    process.env.SKIP_FOUNDRY_API = "true";
    stubFetch();
    await plugin.verifyConditions({}, context());
    await plugin.verifyRelease({}, context({ options: { dryRun: true } }));
    await plugin.publish({}, context());
    await plugin.success({}, context());
    assert.equal(calls.length, 0);
    assert.equal(status().outcome, "skipped");
  });

  it("publish sends the latest manifest URL and records success", async () => {
    process.env.PACKAGE_RELEASE_TOKEN = "fvttp_x";
    stubFetch(respond(200, { status: "success" }));
    await plugin.publish({}, context());
    await plugin.success({}, context());
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.release.manifest, "https://downloads.r2plays.games/futurehax/oh-you-dead/latest/module.json");
    assert.equal(body["dry-run"], false);
    assert.equal(status().outcome, "published");
  });

  it("publish keeps the release going on an API error, then success fails the run", async () => {
    process.env.PACKAGE_RELEASE_TOKEN = "fvttp_x";
    stubFetch(respond(401, { status: "error", message: "Invalid token" }));
    await plugin.publish({}, context());
    assert.equal(status().outcome, "failed");
    await assert.rejects(
      plugin.success({}, context()),
      (error) =>
        error.semanticRelease &&
        /Foundry VTT listing was not updated/.test(error.message) &&
        /already exists/.test(error.details),
    );
  });

  it("already-exists on re-publish counts as success", async () => {
    process.env.PACKAGE_RELEASE_TOKEN = "fvttp_x";
    stubFetch(respond(400, alreadyExists));
    await plugin.publish({}, context());
    await plugin.success({}, context());
    assert.equal(status().outcome, "already-exists");
  });

  it("verifyRelease validates with a Foundry dry run only in semantic-release dry-run mode", async () => {
    process.env.PACKAGE_RELEASE_TOKEN = "fvttp_x";
    stubFetch(respond(200, { status: "success", message: "Dry run completed successfully." }));
    await plugin.verifyRelease({}, context());
    assert.equal(calls.length, 0);
    await plugin.verifyRelease({}, context({ options: { dryRun: true } }));
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body["dry-run"], true);
    assert.equal(body.release.manifest, "https://downloads.r2plays.games/futurehax/oh-you-dead/latest/module.json");
  });

  it("verifyRelease fails the dry run when Foundry rejects the token", async () => {
    process.env.PACKAGE_RELEASE_TOKEN = "fvttp_bad";
    stubFetch(respond(403, { status: "error", message: "Invalid token" }));
    await assert.rejects(plugin.verifyRelease({}, context({ options: { dryRun: true } })), /HTTP 403/);
  });
});
